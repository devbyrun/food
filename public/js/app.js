// Client-side Application Core
const App = {
  ws: null,
  wsCallbacks: new Map(),

  // -------------------------------------------------------------
  // 1. Audio Sound Effects Synthesizer (Web Audio API)
  // -------------------------------------------------------------
  playChime(type = 'bell') {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'bell') {
        // High pitch ding for service call
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.6);
      } else if (type === 'order') {
        // Dual chime for new kitchen order
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.15); // E5
        gain.gain.setValueAtTime(0.4, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.8);
      } else if (type === 'success') {
        // Cheerful triad
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
      }
    } catch (e) {
      // Audio context might require user interaction first
    }
  },

  // -------------------------------------------------------------
  // 2. Toast Notifications
  // -------------------------------------------------------------
  toast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    if (type === 'success') toast.style.borderLeftColor = 'var(--success)';
    if (type === 'warning') toast.style.borderLeftColor = 'var(--warning)';
    if (type === 'danger') toast.style.borderLeftColor = 'var(--danger)';

    toast.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span>${type === 'success' ? '✅' : type === 'warning' ? '⚠️' : type === 'danger' ? '❌' : '🔔'}</span>
        <span>${message}</span>
      </div>
    `;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  // -------------------------------------------------------------
  // 3. WebSocket Realtime Client
  // -------------------------------------------------------------
  initWebSocket(onMessageCallback) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[WebSocket] Connected to realtime server');
        if (this.currentStoreId) {
          this.subscribe(`store:${this.currentStoreId}`);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (onMessageCallback) onMessageCallback(data);
        } catch (e) {
          console.error('[WebSocket Parse Error]:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('[WebSocket] Connection closed. Reconnecting in 3s...');
        setTimeout(() => this.initWebSocket(onMessageCallback), 3000);
      };

      this.ws.onerror = (err) => {
        console.error('[WebSocket Error]:', err);
      };
    } catch (e) {
      console.error('[WebSocket Init Error]:', e);
    }
  },

  subscribe(channel) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', channel }));
    }
  },

  // -------------------------------------------------------------
  // 4. Utility Formatters
  // -------------------------------------------------------------
  formatMoney(amount) {
    return '฿' + parseFloat(amount || 0).toLocaleString('th-TH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  },

  formatTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  },

  formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('th-TH', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  },

  // -------------------------------------------------------------
  // 5. Customer Cart Manager
  // -------------------------------------------------------------
  cart: {
    key: 'food_qr_cart',
    getItems() {
      try {
        return JSON.parse(sessionStorage.getItem(this.key)) || [];
      } catch (e) {
        return [];
      }
    },
    saveItems(items) {
      sessionStorage.setItem(this.key, JSON.stringify(items));
      window.dispatchEvent(new Event('cartUpdated'));
    },
    addItem(item) {
      const items = this.getItems();
      // Generate a unique fingerprint for item + selected options + special notes
      const optSignature = (item.options || []).map(o => o.name).sort().join('|');
      const itemSig = `${item.menu_id}_${optSignature}_${item.special_notes || ''}`;

      const existing = items.find(i => i.signature === itemSig);
      if (existing) {
        existing.quantity += (item.quantity || 1);
      } else {
        items.push({ ...item, signature: itemSig, quantity: item.quantity || 1 });
      }
      this.saveItems(items);
    },
    removeItem(index) {
      const items = this.getItems();
      items.splice(index, 1);
      this.saveItems(items);
    },
    updateQuantity(index, delta) {
      const items = this.getItems();
      if (items[index]) {
        items[index].quantity += delta;
        if (items[index].quantity <= 0) {
          items.splice(index, 1);
        }
        this.saveItems(items);
      }
    },
    clear() {
      sessionStorage.removeItem(this.key);
      window.dispatchEvent(new Event('cartUpdated'));
    },
    getCount() {
      return this.getItems().reduce((sum, item) => sum + item.quantity, 0);
    },
    getTotal() {
      return this.getItems().reduce((sum, item) => {
        const optTotal = (item.options || []).reduce((s, o) => s + parseFloat(o.extra_price || 0), 0);
        return sum + (parseFloat(item.price) + optTotal) * item.quantity;
      }, 0);
    }
  },

  // -------------------------------------------------------------
  // 6. Theme Mode Manager (Dark / Light Mode)
  // -------------------------------------------------------------
  initTheme() {
    const savedTheme = localStorage.getItem('food_theme') || 'dark';
    this.applyTheme(savedTheme);
  },

  applyTheme(theme) {
    const isLight = theme === 'light';
    if (isLight) {
      document.documentElement.setAttribute('data-theme', 'light');
      document.body?.classList.add('theme-light');
    } else {
      document.documentElement.removeAttribute('data-theme');
      document.body?.classList.remove('theme-light');
    }

    document.querySelectorAll('.theme-toggle-checkbox').forEach(cb => {
      cb.checked = isLight;
    });

    document.querySelectorAll('.theme-toggle-text').forEach(el => {
      el.innerText = isLight ? 'สว่าง' : 'มืด';
    });

    localStorage.setItem('food_theme', isLight ? 'light' : 'dark');
  },

  toggleTheme(isLight) {
    this.applyTheme(isLight ? 'light' : 'dark');
  },

  // -------------------------------------------------------------
  // 7. WebP Image Converter & Compressor (Client-side)
  // -------------------------------------------------------------
  processImageToWebP(file, options = {}) {
    const { maxWidth = 1200, maxHeight = 1200, quality = 0.85 } = options;
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('ไม่มีไฟล์ที่เลือก'));
      if (!file.type || !file.type.startsWith('image/')) {
        return reject(new Error('ไฟล์ที่เลือกไม่ใช่รูปภาพ'));
      }

      const reader = new FileReader();
      reader.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error('ไม่สามารถประมวลผลรูปภาพได้'));
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          // Scale down proportionally if larger than maximum bounds
          if (width > maxWidth || height > maxHeight) {
            if (width > height) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            } else {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob((blob) => {
            if (!blob) {
              // Fallback to original file if toBlob fails
              return resolve(file);
            }
            const originalBaseName = (file.name || 'image').replace(/\.[^/.]+$/, '');
            const webpFileName = `${originalBaseName}.webp`;
            const webpFile = new File([blob], webpFileName, { type: 'image/webp' });
            console.log(`[Image] Converted "${file.name}" (${(file.size / 1024).toFixed(1)} KB) -> "${webpFileName}" (${(webpFile.size / 1024).toFixed(1)} KB) [WebP]`);
            resolve(webpFile);
          }, 'image/webp', quality);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
};

// Auto init theme on load
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.initTheme());
  } else {
    App.initTheme();
  }
}

window.App = App;
