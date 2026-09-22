// Client-side Application Core
const App = {
  ws: null,
  wsCallbacks: new Map(),
  audioCtx: null,
  audioUnlocked: false,

  // -------------------------------------------------------------
  // 1. Audio Sound Effects Synthesizer (Web Audio API)
  // -------------------------------------------------------------
  getAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  },

  unlockAudio() {
    if (this.audioUnlocked) return;
    try {
      const ctx = this.getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
        // Play a silent 1ms buffer to fully unlock iOS Safari / Chrome autoplay
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        this.audioUnlocked = true;
        console.log('[Audio] Web Audio API unlocked successfully');
      }
    } catch (e) {
      console.warn('[Audio] unlock error:', e);
    }
  },

  playChime(type = 'order') {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const now = ctx.currentTime;

      if (type === 'order') {
        // --- Rich 2-Step Restaurant Order Bell (Ding-Dong 🔔) ---
        // Note 1: High crisp Bell Ding (D6 = 1174.66Hz + harmonics)
        const osc1 = ctx.createOscillator();
        const osc1Harmonic = ctx.createOscillator();
        const gain1 = ctx.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(1046.50, now); // C6
        osc1Harmonic.type = 'triangle';
        osc1Harmonic.frequency.setValueAtTime(2093.00, now); // C7 harmonic

        gain1.gain.setValueAtTime(0, now);
        gain1.gain.linearRampToValueAtTime(0.5, now + 0.02);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

        osc1.connect(gain1);
        osc1Harmonic.connect(gain1);
        gain1.connect(ctx.destination);

        osc1.start(now);
        osc1Harmonic.start(now);
        osc1.stop(now + 0.45);
        osc1Harmonic.stop(now + 0.45);

        // Note 2: Higher resonant Dong (G6 = 1567.98Hz + harmonic)
        const osc2 = ctx.createOscillator();
        const osc2Harmonic = ctx.createOscillator();
        const gain2 = ctx.createGain();

        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1318.51, now + 0.22); // E6
        osc2Harmonic.type = 'triangle';
        osc2Harmonic.frequency.setValueAtTime(2637.02, now + 0.22); // E7 harmonic

        gain2.gain.setValueAtTime(0, now + 0.22);
        gain2.gain.linearRampToValueAtTime(0.55, now + 0.24);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

        osc2.connect(gain2);
        osc2Harmonic.connect(gain2);
        gain2.connect(ctx.destination);

        osc2.start(now + 0.22);
        osc2Harmonic.start(now + 0.22);
        osc2.stop(now + 1.2);
        osc2Harmonic.stop(now + 1.2);

      } else if (type === 'bell' || type === 'service') {
        // High pitch desk service bell ping
        const osc = ctx.createOscillator();
        const oscH = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1760, now); // A6
        oscH.type = 'triangle';
        oscH.frequency.setValueAtTime(3520, now); // A7

        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.4, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

        osc.connect(gain);
        oscH.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        oscH.start(now);
        osc.stop(now + 0.8);
        oscH.stop(now + 0.8);

      } else if (type === 'success') {
        // Cheerful triad (C5 -> E5 -> G5 -> C6)
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const startTime = now + (idx * 0.08);

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, startTime);
          gain.gain.setValueAtTime(0, startTime);
          gain.gain.linearRampToValueAtTime(0.3, startTime + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.4);

          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(startTime);
          osc.stop(startTime + 0.4);
        });
      }
    } catch (e) {
      console.warn('[Audio playChime Error]:', e);
    }
  },

  // Voice speech announcement (Web Speech API)
  speakVoice(text) {
    if (!('speechSynthesis' in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'th-TH';
      utterance.rate = 1.05;
      utterance.pitch = 1.1;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      // Speech synthesis silent fallback
    }
  },

  // -------------------------------------------------------------
  // 2. Desktop System Notifications (Web Notification API)
  // -------------------------------------------------------------
  requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        console.log('[Notification Permission]:', permission);
      });
    }
  },

  showSystemNotification(title, options = {}, onClickCallback = null) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const notif = new Notification(title, {
        icon: '/assets/img/logo.png',
        badge: '/assets/img/logo.png',
        silent: true, // we use custom playChime Web Audio
        ...options
      });

      notif.onclick = () => {
        window.focus();
        if (onClickCallback) onClickCallback();
        notif.close();
      };
    } catch (e) {
      console.warn('[System Notification Error]:', e);
    }
  },

  // -------------------------------------------------------------
  // 3. Toast Notifications
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
    }, 4500);
  },

  // -------------------------------------------------------------
  // 4. WebSocket Realtime Client
  // -------------------------------------------------------------
  initWebSocket(onMessageCallback) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

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
  // 5. Utility Formatters
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
    document.addEventListener('DOMContentLoaded', () => {
      App.initTheme();
      App.requestNotificationPermission();
    });
  } else {
    App.initTheme();
    App.requestNotificationPermission();
  }

  // One-time interaction listener to unblock browser AudioContext autoplay policy
  const unlockAudioHandler = () => {
    App.unlockAudio();
    window.removeEventListener('click', unlockAudioHandler);
    window.removeEventListener('touchstart', unlockAudioHandler);
    window.removeEventListener('keydown', unlockAudioHandler);
  };
  window.addEventListener('click', unlockAudioHandler, { once: true });
  window.addEventListener('touchstart', unlockAudioHandler, { once: true });
  window.addEventListener('keydown', unlockAudioHandler, { once: true });
}

window.App = App;

