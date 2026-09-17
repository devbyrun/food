const { query } = require('../db');
const { broadcastToStore, broadcastToOrder } = require('./websocket');

// In-memory simulation message history for demo & preview (stored per store)
const telegramSimulatedMessages = [];

async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null, storeId = null) {
  const numericStoreId = storeId ? parseInt(storeId, 10) : null;

  if (!botToken || !chatId) {
    // If no real token/chatId, log to simulator feed
    const simulatedMsg = {
      id: Date.now().toString() + '-' + Math.random().toString(36).substring(2, 6),
      storeId: numericStoreId,
      chatId: chatId || 'simulator-group',
      text,
      replyMarkup,
      sentAt: new Date().toISOString(),
    };
    telegramSimulatedMessages.unshift(simulatedMsg);
    if (telegramSimulatedMessages.length > 200) telegramSimulatedMessages.pop();

    if (numericStoreId) {
      broadcastToStore(numericStoreId, 'telegram_simulated_message', { message: simulatedMsg, storeId: numericStoreId });
    }

    return { ok: true, simulated: true, result: { message_id: simulatedMsg.id } };
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    return data;
  } catch (err) {
    console.error('[Telegram API Error]:', err.message);
    return { ok: false, error: err.message };
  }
}

async function sendKitchenOrderNotification(store, order, orderItems, table) {
  const storeId = store?.id || order?.store_id;
  const botToken = store?.telegram_bot_token;
  const kitchenChatId = store?.telegram_kitchen_chat_id;

  const isTakeaway = Boolean(table.is_takeaway || table.table_number === 'กลับบ้าน' || table.table_number === 'สั่งกลับบ้าน');
  const tableTitle = isTakeaway ? '🛍️ [ออเดอร์ใหม่ - สั่งกลับบ้าน (Takeaway)]' : `👨‍🍳 <b>[ออเดอร์ใหม่เข้าครัว] โต๊ะ ${table.table_number}</b>`;

  for (const item of orderItems) {
    let optionsText = '';
    if (item.options && item.options.length > 0) {
      optionsText = item.options.map(o => `  • ${o.name || o.option_name}`).join('\n');
    }

    const text = `${tableTitle}\n` +
      `-----------------------------\n` +
      `🍽️ <b>${item.menu_name || item.name}</b> x <b>${item.quantity}</b>\n` +
      (optionsText ? `📋 <i>ตัวเลือก:</i>\n${optionsText}\n` : '') +
      (item.special_notes ? `⚠️ <i>หมายเหตุ:</i> ${item.special_notes}\n` : '') +
      `⏱️ เวลาสั่ง: ${new Date().toLocaleTimeString('th-TH')}\n` +
      `🆔 รหัสออเดอร์: #${order.order_number}`;

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: isTakeaway ? '✅ ปรุงเสร็จแล้ว (พร้อมใส่กล่อง/ถุง)' : '✅ ปรุงเสร็จแล้ว (Ready to Serve)',
            callback_data: `kdone:${item.id || item.order_item_id}`,
          },
        ],
      ],
    };

    const result = await sendTelegramMessage(botToken, kitchenChatId, text, inlineKeyboard, storeId);
    
    // Update telegram_msg_id if possible
    if (result && result.result && result.result.message_id && item.id) {
      await query(`UPDATE order_items SET telegram_msg_id = $1 WHERE id = $2`, [
        result.result.message_id.toString(),
        item.id,
      ]).catch(() => {});
    }
  }
}

async function sendServiceReadyNotification(store, orderItem, table) {

  const storeId = store?.id;
  const botToken = store?.telegram_bot_token;
  const serviceChatId = store?.telegram_service_chat_id;

  const isTakeaway = Boolean(table.is_takeaway || table.table_number === 'กลับบ้าน' || table.table_number === 'สั่งกลับบ้าน');
  const headerText = isTakeaway ? '🛍️ <b>[อาหารพร้อมส่งมอบ - สั่งกลับบ้าน]</b>' : `🍽️ <b>[อาหารพร้อมเสิร์ฟ] โต๊ะ ${table.table_number}</b>`;
  const locationText = isTakeaway ? `📍 จุดส่งมอบ: <b>เคาน์เตอร์รับอาหารกลับบ้าน (Takeaway)</b>` : `📍 นำไปเสิร์ฟที่: โต๊ะ <b>${table.table_number}</b>`;

  const text = `${headerText}\n` +
    `-----------------------------\n` +
    `✨ <b>${orderItem.menu_name}</b> x <b>${orderItem.quantity}</b>\n` +
    `${locationText}\n` +
    `⏱️ เวลาปรุงเสร็จ: ${new Date().toLocaleTimeString('th-TH')}`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: isTakeaway ? '🛍️ ส่งมอบลูกค้าแล้ว (Completed)' : '🚀 เสิร์ฟเรียบร้อย (Served)',
          callback_data: `sserved:${orderItem.id}`,
        },
      ],
    ],
  };

  return await sendTelegramMessage(botToken, serviceChatId, text, inlineKeyboard, storeId);
}

async function handleTelegramWebhook(body) {
  if (!body) return { ok: true };

  // Handle Callback Query (Button Press)
  if (body.callback_query) {
    const callbackData = body.callback_query.data;
    const message = body.callback_query.message;
    const callbackQueryId = body.callback_query.id;

    if (callbackData && callbackData.startsWith('kdone:')) {
      const itemId = callbackData.split(':')[1];
      // Update item to 'ready'
      const itemRes = await query(
        `UPDATE order_items SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [itemId]
      );

      if (itemRes.rows.length > 0) {
        const item = itemRes.rows[0];
        const orderRes = await query(`SELECT * FROM orders WHERE id = $1`, [item.order_id]);
        if (orderRes.rows.length > 0) {
          const order = orderRes.rows[0];
          const storeRes = await query(`SELECT * FROM stores WHERE id = $1`, [order.store_id]);
          const tableRes = await query(`SELECT * FROM restaurant_tables WHERE id = $1`, [order.table_id]);

          if (storeRes.rows.length > 0 && tableRes.rows.length > 0) {
            const store = storeRes.rows[0];
            const table = tableRes.rows[0];

            // Send notification to Service Team
            await sendServiceReadyNotification(store, item, table);

            // Broadcast real-time update
            broadcastToStore(store.id, 'order_item_status_updated', {
              orderItemId: item.id,
              orderId: order.id,
              tableId: table.id,
              status: 'ready',
              item,
            });
            broadcastToOrder(order.id, 'item_status_updated', {
              orderItemId: item.id,
              status: 'ready',
            });
          }
        }
      }
    } else if (callbackData && callbackData.startsWith('sserved:')) {
      const itemId = callbackData.split(':')[1];
      // Update item to 'served'
      const itemRes = await query(
        `UPDATE order_items SET status = 'served', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [itemId]
      );

      if (itemRes.rows.length > 0) {
        const item = itemRes.rows[0];
        const orderRes = await query(`SELECT * FROM orders WHERE id = $1`, [item.order_id]);
        if (orderRes.rows.length > 0) {
          const order = orderRes.rows[0];
          const tableRes = await query(`SELECT * FROM restaurant_tables WHERE id = $1`, [order.table_id]);

          broadcastToStore(order.store_id, 'order_item_status_updated', {
            orderItemId: item.id,
            orderId: order.id,
            tableId: tableRes.rows[0]?.id,
            status: 'served',
            item,
          });
          broadcastToOrder(order.id, 'item_status_updated', {
            orderItemId: item.id,
            status: 'served',
          });
        }
      }
    }
  }

  return { ok: true };
}

function getSimulatedMessages(storeId = null) {
  if (!storeId) return telegramSimulatedMessages;
  const sId = parseInt(storeId, 10);
  return telegramSimulatedMessages.filter(m => m.storeId === sId);
}

function clearSimulatedMessages(storeId = null) {
  if (!storeId) {
    telegramSimulatedMessages.length = 0;
    return true;
  }
  const sId = parseInt(storeId, 10);
  for (let i = telegramSimulatedMessages.length - 1; i >= 0; i--) {
    if (telegramSimulatedMessages[i].storeId === sId) {
      telegramSimulatedMessages.splice(i, 1);
    }
  }
  return true;
}

async function sendPaymentSlipNotification(store, payment, order, table, slipUrl) {
  const storeId = store?.id || order?.store_id;
  const botToken = store?.telegram_bot_token;
  const slipChatId = store?.telegram_slip_chat_id;

  const tableNumber = table?.table_number || (order?.table_id ? `ID #${order.table_id}` : 'ไม่ระบุโต๊ะ');
  const amount = payment?.amount_received || order?.net_amount || 0;
  const orderNumber = order?.order_number || '-';

  const text = `💸 <b>[แจ้งเตือนสลิปโอนเงินลูกค้า]</b>\n` +
    `-----------------------------\n` +
    `🏪 ร้าน: <b>${store?.name || ''}</b>\n` +
    `📍 โต๊ะ: <b>${tableNumber}</b>\n` +
    `🆔 รหัสออเดอร์: #${orderNumber}\n` +
    `💰 ยอดชำระ: <b>${parseFloat(amount).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</b>\n` +
    `💳 ช่องทาง: พร้อมเพย์ (PromptPay)\n` +
    `⏱️ เวลาแจ้งโอน: ${new Date().toLocaleTimeString('th-TH')}\n` +
    (slipUrl ? `🔗 ดูรูปสลิป: ${slipUrl}` : '');

  return await sendTelegramMessage(botToken, slipChatId, text, null, storeId);
}

module.exports = {
  sendTelegramMessage,
  sendKitchenOrderNotification,
  sendServiceReadyNotification,
  sendPaymentSlipNotification,
  handleTelegramWebhook,
  getSimulatedMessages,
  clearSimulatedMessages,
};

