const WebSocket = require('ws');

let wss = null;
const clients = new Set();

function initWebSocket(server) {
  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    ws.subscriptions = new Set();
    clients.add(ws);

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        // Handle Subscribe Room
        if (data.type === 'subscribe') {
          if (data.channel) {
            ws.subscriptions.add(data.channel);
            ws.send(JSON.stringify({ type: 'subscribed', channel: data.channel }));
          }
        }
        
        // Handle Unsubscribe Room
        if (data.type === 'unsubscribe') {
          if (data.channel) {
            ws.subscriptions.delete(data.channel);
          }
        }

        // Ping / Pong Heartbeat
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (err) {
        console.error('[WebSocket Message Error]:', err.message);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('[WebSocket Client Error]:', err.message);
      clients.delete(ws);
    });

    // Send initial greeting
    ws.send(JSON.stringify({ type: 'connected', message: 'Real-time WebSocket connected' }));
  });

  console.log('[WebSocket] Server initialized and listening for connections.');
  return wss;
}

function broadcastToChannel(channel, event, payload) {
  if (!wss) return;
  const message = JSON.stringify({ type: event, channel, data: payload, timestamp: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && client.subscriptions && client.subscriptions.has(channel)) {
      client.send(message);
    }
  }
}

function broadcastAll(event, payload) {
  if (!wss) return;
  const message = JSON.stringify({ type: event, data: payload, timestamp: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function broadcastToStore(storeId, event, payload) {
  broadcastToChannel(`store:${storeId}`, event, payload);
  broadcastToChannel(`store:${storeId}:kitchen`, event, payload);
  broadcastToChannel(`store:${storeId}:service`, event, payload);
  broadcastToChannel(`store:${storeId}:tables`, event, payload);
  broadcastToChannel(`store:${storeId}:pos`, event, payload);
  broadcastAll(event, payload);
}

function broadcastToOrder(orderId, event, payload) {
  broadcastToChannel(`order:${orderId}`, event, payload);
  broadcastAll(event, payload);
}

module.exports = {
  initWebSocket,
  broadcastToChannel,
  broadcastAll,
  broadcastToStore,
  broadcastToOrder,
};
