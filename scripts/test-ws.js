const { io } = require('socket.io-client');

const socket = io('http://localhost:5000', { transports: ['websocket'] });

socket.on('connect', () => {
  console.log('Connected to server');
  socket.emit('subscribe', { symbol: 'LKOH', timeframe: '1h', source: 'moex' });
  console.log('Subscribed to LKOH 1h');
});

socket.on('subscribed', (data) => {
  console.log('Subscription confirmed:', data);
});

socket.on('candle_update', (data) => {
  const c = data.candle;
  console.log(`[${new Date().toLocaleTimeString()}] ${data.symbol} ${data.timeframe}: O=${c.open} H=${c.high} L=${c.low} C=${c.close} V=${c.volume}`);
});

socket.on('error', (err) => {
  console.error('Error:', err);
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
});

// Wait 30 seconds for updates
setTimeout(() => {
  console.log('Done waiting. Disconnecting...');
  socket.disconnect();
  process.exit(0);
}, 30000);
