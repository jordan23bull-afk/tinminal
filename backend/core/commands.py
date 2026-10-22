"""Шина команд: единственный способ изменить состояние.

Каждая команда, меняющая состояние, обязана вернуть обратную команду.
Отмена — это применение `inverse` последней неотменённой команды, поэтому
журнал `commands` и стек отмены — одна и та же таблица.

Применение обратной команды не логируется заново: иначе отмена порождала бы
новую запись, которую тоже можно отменить, и стек зациклился бы.
Поэтому у обработчиков есть параметр record.
"""

import logging
from dataclasses import dataclass, field
from core import store
from core import alerts as alerts_module

logger = logging.getLogger(__name__)


@dataclass
class Result:
    ok: bool
    error: str = ""
    code: str = ""
    data: dict = field(default_factory=dict)
    # список пар (имя_события, полезная нагрузка) для рассылки клиентам
    events: list = field(default_factory=list)
    version: int = None


def _chart_config(layout_id, index):
    """Один элемент массива charts раскладки."""
    layout = store.get_layout(layout_id)
    if not layout:
        return None
    charts = layout["state"].get("charts") or []
    while len(charts) <= index:
        charts.append({})
    return charts[index]


def _set_chart_field(layout_id, index, field, value, remove=False):
    layout = store.get_layout(layout_id)
    if not layout:
        return None, None
    state = layout["state"]
    # Важно: список обязан быть положен обратно в state. Иначе при отсутствии
    # ключа 'charts' выражение state.get("charts") or [] создаст отдельный
    # список, правки в нём пропадут, и в базу уйдёт прежнее состояние.
    charts = state.get("charts")
    if not isinstance(charts, list):
        charts = []
    while len(charts) <= index:
        charts.append({})
    old = charts[index].get(field)
    if remove:
        # Очистка поля — это именно удаление ключа. Если записать сюда
        # прежнее значение, отмена отмены не вернёт поле в исходное
        # отсутствие: график навсегда получил бы лишний ключ.
        charts[index].pop(field, None)
    else:
        charts[index][field] = value
    state["charts"] = charts
    store.save_layout_state(layout_id, state)
    return old, charts[index]


def _ensure_layout(layout_id):
    return store.get_layout(layout_id) if layout_id else None


# Поля панели, которые сервер хранит в состоянии раскладки.
PANEL_FIELDS = ("symbol", "timeframe", "chart_type", "indicators")

# Больше панелей не бывает: галерея в интерфейсе ограничена 12.
MAX_PANELS = 12


def _clean_panel(cfg):
    """Оставить в панели только известные серверу поля."""
    if not isinstance(cfg, dict):
        return {}
    return {k: cfg[k] for k in PANEL_FIELDS if cfg.get(k) is not None}


def _visible_count(state):
    """Сколько панелей видно: из сетки, иначе — по числу панелей в пуле."""
    grid = (state or {}).get("layout") or {}
    count = grid.get("count")
    if count:
        return int(count)
    return len((state or {}).get("charts") or [])


def _rebind_objects(layout_id, charts, count):
    """Перепривязать объекты к видимым панелям по символу.

    Объект принадлежит панели с тем же символом. Такой панели нет — прежний
    индекс сохраняется: рисунок остаётся привязан к своему символу и просто
    не виден, пока панель с этим символом не вернётся.
    """
    visible = (charts or [])[:count]
    for obj in store.list_objects(layout_id):
        symbol = obj.get("symbol")
        if not symbol:
            continue
        target = None
        for i, panel in enumerate(visible):
            if (panel or {}).get("symbol") == symbol:
                target = i
                break
        if target is None or target == obj.get("chart_index"):
            continue
        store.set_object_chart_index(obj["id"], target)


def _infer_layout_id(kind, payload):
    """Достать раскладку из самого адресуемого объекта.

    Клиент может не знать раскладку (например при работе с объектом, полученным
    по событию). Без этого идентификатора команда не попала бы в журнал
    раскладки, не двигала бы версию и не была бы отменяема.
    """
    if payload.get("layout_id"):
        return payload["layout_id"]
    object_id = payload.get("id") or payload.get("object_id")
    if kind.startswith("object.") and object_id:
        found = store.get_object(object_id)
        if found:
            return found.get("layout_id")
        return None
    if kind.startswith("alert.") and object_id:
        found = store.get_alert(object_id)
        if found:
            return found.get("layout_id")
        return None
    return None


# --- обработчики -------------------------------------------------------------
# Сигнатура: (payload, record) -> (inverse_payload | None, events, data)

def _h_layout_create(payload, record):
    name = payload.get("name") or "Раскладка"
    layout = store.create_layout(
        name=name,
        layout_id=payload.get("layout_id"),
        state=payload.get("state") or {},
    )
    events = [("layout_added", {"layout": layout})]
    imported = 0
    for obj in payload.get("objects") or []:
        store.create_object(
            layout["id"], obj.get("kind", "hline"), obj.get("symbol"),
            obj.get("timeframe"), int(obj.get("chart_index", 0)),
            obj.get("data") or {}, obj.get("style") or {},
            object_id=obj.get("object_id"),
        )
        imported += 1
    # Отмена удаления раскладки возвращает и её алерты.
    created_alerts = _restore_alerts(payload.get("alerts"))
    events += [("alert_added", {"alert": a}) for a in created_alerts]
    data = {"layout": layout, "imported_objects": imported}
    inverse = {"kind": "layout.delete", "payload": {"layout_id": layout["id"]}}
    return inverse, events, data


def _h_layout_rename(payload, record):
    layout = _ensure_layout(payload.get("layout_id"))
    if not layout:
        return None, [], {}
    updated = store.rename_layout(layout["id"], payload.get("name") or layout["name"])
    inverse = {"kind": "layout.rename",
               "payload": {"layout_id": layout["id"], "name": layout["name"]}}
    return inverse, [("layout_changed", {"layout": updated})], {"layout": updated}


def _h_layout_set_grid(payload, record):
    """Записать геометрию панелей и перепривязать к ним объекты.

    Геометрия — часть состояния раскладки: панели переживают перезагрузку
    и одинаковы у всех, кто открыл раскладку. Пул панелей при этом не
    обрезается: убранная панель помнит свой символ и вернётся, когда её
    снова покажут.
    """
    layout = _ensure_layout(payload.get("layout_id"))
    if not layout:
        return None, [], {}
    try:
        count = int(payload.get("count") or 0)
        rows = int(payload.get("rows") or 0)
        cols = int(payload.get("cols") or 0)
    except (TypeError, ValueError):
        raise CommandError("Сетка задана неверно", code="invalid_grid")
    cells = payload.get("cells")
    if count < 1 or count > MAX_PANELS:
        raise CommandError(f"Недопустимое число панелей: {count}", code="invalid_grid")
    if not isinstance(cells, list) or len(cells) != count:
        raise CommandError("Сетка не совпадает с числом панелей", code="invalid_grid")
    if rows < 1 or cols < 1:
        raise CommandError("Недопустимая сетка", code="invalid_grid")

    state = layout["state"]
    old_grid = state.get("layout") or {}
    old_count = int(old_grid.get("count") or 1)
    old_panels = list(state.get("charts") or [])

    charts = list(old_panels)
    incoming = payload.get("charts")
    touched = 0
    if isinstance(incoming, list):
        for i, cfg in enumerate(incoming):
            if i >= len(charts):
                charts.append({})
            charts[i] = _clean_panel(cfg)
            touched = i + 1
    while len(charts) < count:
        charts.append({})

    state["charts"] = charts
    state["layout"] = {"count": count, "rows": rows, "cols": cols, "cells": cells}
    _rebind_objects(layout["id"], charts, count)
    store.save_layout_state(layout["id"], state)

    # Отмена возвращает прежнюю сетку и прежние панели: иначе раскладка
    # осталась бы с чужим числом панелей и чужими символами.
    inverse = {"kind": "layout.set_grid", "payload": {
        "layout_id": layout["id"],
        "count": old_count,
        "rows": int(old_grid.get("rows") or 1),
        "cols": int(old_grid.get("cols") or 1),
        "cells": old_grid.get("cells") or [[1, 1]],
        "charts": old_panels[:touched],
    }}
    return inverse, [], {"layout": store.get_layout(layout["id"])}


def _h_layout_delete(payload, record):
    layout = _ensure_layout(payload.get("layout_id"))
    if not layout:
        return None, [], {}
    # Снимок для отмены: без объектов и алертов отмена вернула бы пустую
    # раскладку, потеряв всё нарисованное.
    objects = store.list_objects(layout["id"])
    alerts = store.list_alerts(layout["id"])
    snapshot = {
        "layout_id": layout["id"],
        "name": layout["name"],
        "state": layout["state"],
    }
    store.delete_layout(layout["id"])
    inverse = {"kind": "layout.create", "payload": {
        "layout_id": snapshot["layout_id"],
        "name": snapshot["name"],
        "state": snapshot["state"],
        "objects": [
            {"kind": o["kind"], "symbol": o["symbol"], "timeframe": o["timeframe"],
             "chart_index": o["chart_index"], "data": o["data"], "style": o["style"],
             "object_id": o["id"]}
            for o in objects
        ],
        "alerts": alerts,
    }}
    return inverse, [("layout_removed", {"layout_id": layout["id"]})], {"deleted": layout["id"]}


def _restore_alerts(alert_specs):
    """Восстановить алерты с прежними идентификаторами.

    Возвращает созданные алерты: их нужно и разослать событием
    alert_added, и отдать инициатору команды, которому рассылка не достаётся.
    """
    created = []
    for a in alert_specs or []:
        restored = store.create_alert(
            a.get("layout_id"),
            symbol=a.get("symbol"),
            condition=a.get("condition") or "cross",
            price=a.get("price"),
            price_high=a.get("price_high"),
            timeframe=a.get("timeframe") or "1m",
            object_id=a.get("object_id"),
            channels=a.get("channels"),
            expires_at=a.get("expires_at"),
            repeat_mode=a.get("repeat_mode") or "once",
            alert_id=a.get("id"),
        )
        if restored:
            created.append(restored)
    return created


def _h_object_create(payload, record):
    layout_id = payload.get("layout_id")
    if not _ensure_layout(layout_id):
        return None, [], {}
    # Идентификатор кладём в payload до логирования команды: иначе повтор
    # (redo) создал бы объект с другим id, и ссылка на старую потерялась бы.
    object_id = payload.get("object_id") or store.new_id()
    payload["object_id"] = object_id
    obj = store.create_object(
        layout_id,
        payload.get("kind") or "hline",
        payload.get("symbol"),
        payload.get("timeframe"),
        int(payload.get("chart_index", 0)),
        payload.get("data") or {},
        payload.get("style") or {},
        object_id=object_id,
    )
    events = [("object_added", {"object": obj})]
    # Отмена удаления возвращает объект вместе с его алертами.
    for spec in payload.get("alerts") or []:
        spec.setdefault("layout_id", layout_id)
        spec["object_id"] = object_id
    created_alerts = _restore_alerts(payload.get("alerts"))
    events += [("alert_added", {"alert": a}) for a in created_alerts]
    inverse = {"kind": "object.delete", "payload": {"id": obj["id"]}}
    return inverse, events, {"object": obj}


def _h_object_update(payload, record):
    current = store.get_object(payload.get("id"))
    if not current:
        return None, [], {}
    updated = store.update_object(current["id"], payload.get("data"), payload.get("style"))
    inverse = {"kind": "object.update", "payload": {
        "id": current["id"],
        "data": current["data"],
        "style": current["style"],
    }}
    return inverse, [("object_updated", {"object": updated})], {"object": updated}


def _h_object_delete(payload, record):
    current = store.get_object(payload.get("id"))
    if not current:
        return None, [], {}
    attached = store.list_alerts_by_object(current["id"])
    store.delete_object(current["id"])
    events = [("object_removed", {"id": current["id"]})]
    for alert in attached:
        events.append(("alert_removed", {"alert": alert}))
    inverse = {"kind": "object.create",
               "payload": {
                   "layout_id": current["layout_id"],
                   "kind": current["kind"],
                   "symbol": current["symbol"],
                   "timeframe": current["timeframe"],
                   "chart_index": current["chart_index"],
                   "data": current["data"],
                   "style": current["style"],
                   "object_id": current["id"],
                   "alerts": attached,
               }}
    return inverse, events, {"deleted": current["id"]}


AUTO_LEVEL_KIND = "auto_level"


def _find_auto_level(layout_id, symbol):
    for obj in store.list_objects_by_symbol(layout_id, symbol):
        if obj["kind"] == AUTO_LEVEL_KIND:
            return obj
    return None


def _levels_payload(symbol, data):
    """Уровни из объекта в виде, пригодном для повторной установки."""
    d = data or {}
    return {
        "symbol": symbol,
        "day_high": d.get("day_high"),
        "day_low": d.get("day_low"),
        "eve_high": d.get("eve_high"),
        "eve_low": d.get("eve_low"),
    }


def _h_object_set_auto_levels(payload, record):
    """Поставить или снять уровни ATR-сканера для символа.

    Уровни и алерты на них — одно действие. Иначе отмена возвращала бы
    линии без условий срабатывания, а сканер с каждой новой выборкой
    накапливал бы дубли.

    Пустые значения (все уровни None) снимают уровни совсем.
    """
    layout_id = payload.get("layout_id")
    symbol = (payload.get("symbol") or "").upper()
    if not _ensure_layout(layout_id) or not symbol:
        return None, [], {}

    levels = {k: _as_float(payload.get(k))
              for k in ("day_high", "day_low", "eve_high", "eve_low")}
    existing = _find_auto_level(layout_id, symbol)
    events = []
    removed_alerts = []
    kept_alerts = []

    if all(v is None for v in levels.values()):
        data = {"removed": True}
    else:
        data = dict(levels)

    if existing:
        previous = _levels_payload(symbol, existing["data"])
        # Алерт, оставшийся на той же цене, переживает перескан. Иначе
        # сработавший снова вставал бы в бой, а пересечения между
        # сканами терялись бы: у нового алерта свежее время постановки,
        # и after_arming отбрасывает сделки раньше него.
        for alert in store.list_alerts_by_object(existing["id"]):
            price = _as_float(alert.get("price"))
            if price is not None and price in levels.values():
                kept_alerts.append(alert)
                continue
            removed_alerts.append(alert)
            store.delete_alert(alert["id"])
        # Объект обновляем на месте: идентификатор не меняется, линии
        # уровней остаются, а не перерисовываются заново.
        obj = store.update_object(existing["id"], data)
        events.append(("object_updated", {"object": obj}))
    else:
        previous = _levels_payload(symbol, None)
        obj = store.create_object(
            layout_id, AUTO_LEVEL_KIND, symbol, payload.get("timeframe") or "1m",
            int(payload.get("chart_index", 0)), data, {}, object_id=payload.get("object_id"),
        )
        events.append(("object_added", {"object": obj}))

    # Алерты ставит сервер: клиент их не проверяет и без этого условия
    # они просто висели бы мёртвым грузом в памяти браузера.
    alerts_specs = []
    for key in ("day_high", "day_low", "eve_high", "eve_low"):
        price = levels.get(key)
        if price is None:
            continue
        if any(_as_float(a.get("price")) == price for a in kept_alerts):
            continue
        spec = {
            "layout_id": layout_id, "symbol": symbol, "price": price,
            # Единое правило для всех алертов: цена коснулась уровня.
            "condition": "cross",
            "timeframe": payload.get("timeframe") or "1m",
            "object_id": obj["id"], "channels": ["sound", "browser"],
            "repeat_mode": "once",
            "expires_at": store.now() + 7 * 24 * 3600,
        }
        alerts_specs.append(spec)
    created_alerts = _restore_alerts(alerts_specs)
    events += [("alert_added", {"alert": a}) for a in created_alerts]
    events += [("alert_removed", {"alert": a}) for a in removed_alerts]

    inverse = {"kind": "object.set_auto_levels", "payload": dict(previous, layout_id=layout_id)}
    result = {"object": obj, "alerts": len(alerts_specs) + len(kept_alerts),
              "removed_objects": [],
              "removed_alerts": removed_alerts,
              "created_alerts": created_alerts}
    return inverse, events, result


def _as_float(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _h_object_clear_symbol(payload, record):
    layout_id = payload.get("layout_id")
    symbol = payload.get("symbol")
    # Без символа команда очищает раскладку целиком: это кнопка
    # «удалить всё», и она тоже должна отменяться одной операцией.
    if not _ensure_layout(layout_id):
        return None, [], {}
    if symbol:
        victims = store.list_objects_by_symbol(layout_id, symbol)
    else:
        victims = store.list_objects(layout_id)
    removed_alerts = []
    for obj in victims:
        removed_alerts.extend(store.list_alerts_by_object(obj["id"]))
        store.delete_object(obj["id"])
    events = [("object_removed", {"id": o["id"]}) for o in victims]
    events += [("alert_removed", {"alert": a}) for a in removed_alerts]
    inverse = {"kind": "object.create_many",
               "payload": {
                   "layout_id": layout_id,
                   "objects": [
                       {"kind": o["kind"], "symbol": o["symbol"], "timeframe": o["timeframe"],
                        "chart_index": o["chart_index"], "data": o["data"], "style": o["style"],
                        "object_id": o["id"]}
                       for o in victims
                   ],
                   "alerts": removed_alerts,
               }}
    # Удалённое возвращаем в ответе: сервер не рассылает события обратно
    # отправителю, и без этого кнопка очистки ничего не убрала бы у него.
    return inverse, events, {"removed": len(victims),
                             "removed_objects": victims,
                             "removed_alerts": removed_alerts}


def _h_object_create_many(payload, record):
    layout_id = payload.get("layout_id")
    created = []
    for spec in payload.get("objects") or []:
        created.append(store.create_object(
            layout_id, spec.get("kind", "hline"), spec.get("symbol"),
            spec.get("timeframe"), int(spec.get("chart_index", 0)),
            spec.get("data") or {}, spec.get("style") or {},
            object_id=spec.get("object_id"),
        ))
    events = [("object_added", {"object": o}) for o in created]
    for spec in payload.get("alerts") or []:
        spec.setdefault("layout_id", layout_id)
    created_alerts = _restore_alerts(payload.get("alerts"))
    events += [("alert_added", {"alert": a}) for a in created_alerts]
    inverse = {"kind": "object.delete_many",
               "payload": {"ids": [o["id"] for o in created]}}
    # Объекты возвращаем в ответе: сервер не рассылает событие обратно
    # отправителю, и без них у него не появятся новые линии.
    return inverse, events, {"created": len(created), "objects": created}


def _h_object_delete_many(payload, record):
    ids = payload.get("ids") or []
    victims = [o for o in (store.get_object(i) for i in ids) if o]
    removed_alerts = []
    for obj in victims:
        removed_alerts.extend(store.list_alerts_by_object(obj["id"]))
        store.delete_object(obj["id"])
    events = [("object_removed", {"id": o["id"]}) for o in victims]
    events += [("alert_removed", {"alert": a}) for a in removed_alerts]
    inverse = {"kind": "object.create_many", "payload": {"layout_id": victims[0]["layout_id"] if victims else None,
                "objects": [{"kind": o["kind"], "symbol": o["symbol"], "timeframe": o["timeframe"],
                             "chart_index": o["chart_index"], "data": o["data"], "style": o["style"],
                             "object_id": o["id"]} for o in victims],
                "alerts": removed_alerts}}
    return inverse, events, {"deleted": len(victims),
                             "removed_objects": victims,
                             "removed_alerts": removed_alerts}


def _h_alert_create(payload, record):
    layout_id = payload.get("layout_id")
    if not _ensure_layout(layout_id):
        return None, [], {}
    condition = payload.get("condition") or "cross"
    # Без проверки опечатка в условии дала бы алерт, который не сработает
    # никогда, и это выглядело бы как «алерты не работают».
    if condition not in alerts_module.CONDITIONS:
        raise CommandError(f"Неизвестное условие алерта: {condition}",
                           code="invalid_condition")
    # Как и у объектов: id должен пережить повтор команды.
    alert_id = payload.get("alert_id") or store.new_id()
    payload["alert_id"] = alert_id
    alert = store.create_alert(
        layout_id,
        symbol=(payload.get("symbol") or "").upper(),
        condition=condition,
        price=payload.get("price"),
        price_high=payload.get("price_high"),
        timeframe=payload.get("timeframe") or "1m",
        object_id=payload.get("object_id"),
        channels=payload.get("channels"),
        expires_at=payload.get("expires_at"),
        repeat_mode=payload.get("repeat_mode") or "once",
        alert_id=alert_id,
    )
    inverse = {"kind": "alert.delete", "payload": {"id": alert["id"]}}
    return inverse, [("alert_added", {"alert": alert})], {"alert": alert}


def _h_alert_update(payload, record):
    current = store.get_alert(payload.get("id"))
    if not current:
        return None, [], {}
    fields = {k: v for k, v in payload.items()
              if k in ("symbol", "timeframe", "condition", "price", "price_high",
                       "expires_at", "channels", "repeat_mode", "status", "object_id")}
    updated = store.update_alert(current["id"], **fields)
    inverse = {"kind": "alert.update", "payload": dict(
        {"id": current["id"]},
        **{k: current.get(k) for k in fields}
    )}
    return inverse, [("alert_updated", {"alert": updated})], {"alert": updated}


def _h_alert_delete(payload, record):
    current = store.get_alert(payload.get("id"))
    if not current:
        return None, [], {}
    store.delete_alert(current["id"])
    inverse = {"kind": "alert.create", "payload": {
        "layout_id": current["layout_id"],
        "symbol": current["symbol"],
        "condition": current["condition"],
        "price": current["price"],
        "price_high": current["price_high"],
        "timeframe": current["timeframe"],
        "object_id": current["object_id"],
        "channels": current["channels"],
        "expires_at": current["expires_at"],
        "repeat_mode": current["repeat_mode"],
        "alert_id": current["id"],
    }}
    return inverse, [("alert_removed", {"alert": current})], {"deleted": current["id"]}


class CommandError(Exception):
    """Команда отклонена: неверные аргументы."""

    def __init__(self, message, code="invalid_command"):
        super().__init__(message)
        self.code = code


def _chart_setter(field, result_key, command_name):
    def handler(payload, record):
        layout_id = payload.get("layout_id")
        if not _ensure_layout(layout_id):
            return None, [], {}
        index = int(payload.get("chart_index", 0))
        value = payload.get(result_key)
        # Без значения команда не должна затирать поле: пустой символ или
        # таймфрейм ломают график, и восстановить его через undo нельзя.
        if value is None or (isinstance(value, str) and not value.strip()):
            raise CommandError(f"Не задано значение для {field}", code="missing_value")
        if isinstance(value, str):
            value = value.strip()
        old, current = _set_chart_field(layout_id, index, field, value)
        # Состав видимых панелей изменился — объекты перепривязываются
        # к панели с тем же символом.
        if field in ("symbol", "timeframe"):
            layout = store.get_layout(layout_id)
            if layout:
                state = layout["state"]
                _rebind_objects(layout_id, state.get("charts") or [],
                                _visible_count(state))
        # Имя команды для обратной операции задаётся явно: собирать его из имени
        # поля нельзя (у типа графика поле chart_type, а команда chart.set_type).
        if old is None:
            inverse = {"kind": "chart.clear_field",
                       "payload": {"layout_id": layout_id, "chart_index": index, "field": field}}
        else:
            inverse = {"kind": command_name,
                       "payload": {"layout_id": layout_id, "chart_index": index,
                                   result_key: old}}
        events = [("chart_changed", {"layout_id": layout_id, "chart_index": index,
                                     "field": field, "value": value})]
        return inverse, events, {result_key: value}
    return handler


def _h_chart_clear_field(payload, record):
    layout = _ensure_layout(payload.get("layout_id"))
    if not layout:
        return None, [], {}
    index = int(payload.get("chart_index", 0))
    field = payload.get("field")
    charts = layout["state"].get("charts")
    old = charts[index].get(field) if isinstance(charts, list) and index < len(charts) else None
    _set_chart_field(layout["id"], index, field, None, remove=True)
    # Обратная операция обязана ставить прежнее значение, а не очищать снова:
    # очистка очисткой поле не вернёт.
    inverse = {"kind": "chart.restore_field",
               "payload": {"layout_id": layout["id"], "chart_index": index,
                           "field": field, "value": old}}
    events = [("chart_changed", {"layout_id": layout["id"], "chart_index": index,
                                 "field": field, "value": None})]
    return inverse, events, {}


def _h_chart_restore_field(payload, record):
    """Вернуть поле графика в прежнее состояние.

    value === None означает «ключа не было» — его и не должно снова
    появляться после отмены отмены.
    """
    layout = _ensure_layout(payload.get("layout_id"))
    if not layout:
        return None, [], {}
    index = int(payload.get("chart_index", 0))
    field = payload.get("field")
    value = payload.get("value")
    _set_chart_field(layout["id"], index, field, value, remove=value is None)
    # Панель снова получила символ — объекты перепривязываются к ней.
    if field in ("symbol", "timeframe"):
        layout = store.get_layout(layout["id"])
        if layout:
            state = layout["state"]
            _rebind_objects(layout["id"], state.get("charts") or [],
                            _visible_count(state))
    events = [("chart_changed", {"layout_id": layout["id"], "chart_index": index,
                                 "field": field, "value": value})]
    return None, events, {field: value}


HANDLERS = {
    "layout.create": _h_layout_create,
    "layout.rename": _h_layout_rename,
    "layout.set_grid": _h_layout_set_grid,
    "layout.delete": _h_layout_delete,
    "object.create": _h_object_create,
    "object.create_many": _h_object_create_many,
    "object.update": _h_object_update,
    "object.delete": _h_object_delete,
    "object.delete_many": _h_object_delete_many,
    "object.clear_symbol": _h_object_clear_symbol,
    "object.set_auto_levels": _h_object_set_auto_levels,
    "alert.create": _h_alert_create,
    "alert.update": _h_alert_update,
    "alert.delete": _h_alert_delete,
    "chart.set_symbol": _chart_setter("symbol", "symbol", "chart.set_symbol"),
    "chart.set_timeframe": _chart_setter("timeframe", "timeframe", "chart.set_timeframe"),
    "chart.set_type": _chart_setter("chart_type", "chart_type", "chart.set_type"),
    "chart.clear_field": _h_chart_clear_field,
    "chart.restore_field": _h_chart_restore_field,
}

# Команды, меняющие состояние, обязаны иметь обратную. Проверяется в тестах.
# restore_field — техническая, обратная операция вызывается изнутри undo.
UNDOABLE = {k for k in HANDLERS if k not in ("layout.delete", "chart.restore_field")}


def apply_command(kind, payload, client_id=None, record=True):
    """Применить команду. Основная точка записи во всём приложении.

    client_id — вкладка, от имени которой пришла команда. Он же ключ
    журнала отмены: вкладка отменяет только свои действия. None — общий
    журнал раскладки (HTTP-путь и самотесты).
    """
    handler = HANDLERS.get(kind)
    if not handler:
        return Result(ok=False, error=f"Неизвестная команда: {kind}", code="unknown_command")

    payload = payload or {}
    layout_id = _infer_layout_id(kind, payload)
    if layout_id:
        payload["layout_id"] = layout_id
    try:
        with store.write_lock():
            version_before = store.get_version(layout_id) if layout_id else None
            inverse, events, data = handler(payload, record)
            if record:
                # Новое действие закрывает ветку повторов: иначе redo
                # переиграл бы отменённое действие поверх нового.
                if layout_id:
                    store.clear_redo(layout_id, client_id)
                store.log_command(layout_id, client_id, kind, payload, inverse or {})
                store.trim_commands(layout_id)
            # Часть обработчиков сама сохраняет состояние раскладки, и такая
            # запись уже увеличивает version. Без этой проверки одна команда
            # поднимала версию на 2.
            version = store.get_version(layout_id) if layout_id else None
            if version == version_before:
                version = store.bump_version(layout_id)
    except CommandError as exc:
        logger.warning("[Commands] %s отклонена: %s", kind, exc)
        return Result(ok=False, error=str(exc), code=exc.code)
    except Exception as exc:
        logger.exception("[Commands] %s не выполнена: %s", kind, exc)
        return Result(ok=False, error=str(exc), code="command_failed")

    return Result(ok=True, data=data, events=events, version=version)


def undo(layout_id, client_id=None):
    """Отменить последнее действие. Возвращает применённую команду.

    Отменяется действие той же вкладки, что и запросила отмену: журнал
    общий для раскладки, но его ветка принадлежит вкладке.
    """
    with store.write_lock():
        command = store.last_command(layout_id, undone=False, client_id=client_id)
        if not command:
            return Result(ok=False, error="Нечего отменять", code="nothing_to_undo")
        inverse = command.get("inverse") or {}
        inverse_kind = inverse.get("kind")
        inverse_payload = dict(inverse.get("payload") or {})
        if not inverse_kind or inverse_kind not in HANDLERS:
            return Result(ok=False, error="У действия нет обратной операции",
                          code="not_undoable")
        # Обратная операция обязана знать раскладку: без неё не будет
        # записи в журнал, движения версии и возможности повторить отмену.
        inverse_payload.setdefault("layout_id", layout_id)
        # record=False: отмена не должна порождать новую запись в журнале
        result = apply_command(inverse_kind, inverse_payload, client_id, record=False)
        if not result.ok:
            return result
        store.set_command_undone(command["id"], True)
        logger.info("[Commands] Отменено %s (#%s) по раскладке %s",
                    command["kind"], command["id"], layout_id)
        result.data["undone_command"] = {"id": command["id"], "kind": command["kind"]}
        result.events.append(("command_undone", {
            "command_id": command["id"], "kind": command["kind"],
        }))
        return result


def redo(layout_id, client_id=None):
    with store.write_lock():
        command = store.last_command(layout_id, undone=True, client_id=client_id)
        if not command:
            return Result(ok=False, error="Нечего повторять", code="nothing_to_redo")
        result = apply_command(command["kind"], command["payload"], client_id, record=False)
        if not result.ok:
            return result
        store.set_command_undone(command["id"], False)
        logger.info("[Commands] Повторено %s (#%s) по раскладке %s",
                    command["kind"], command["id"], layout_id)
        result.data["redone_command"] = {"id": command["id"], "kind": command["kind"]}
        result.events.append(("command_redone", {
            "command_id": command["id"], "kind": command["kind"],
        }))
        return result


def can_undo(layout_id, client_id=None):
    return store.last_command(layout_id, undone=False, client_id=client_id) is not None


def can_redo(layout_id, client_id=None):
    return store.last_command(layout_id, undone=True, client_id=client_id) is not None
