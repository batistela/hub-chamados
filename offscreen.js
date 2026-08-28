// Toca um bipe curto usando WebAudio (não depende de nenhum arquivo de áudio externo).
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playTone = (freq, start, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration + 0.05);
    };
    playTone(880, 0, 0.15);
    playTone(1175, 0.18, 0.2);
    setTimeout(() => ctx.close(), 1000);
  } catch (e) {
    console.warn('falha ao tocar som', e);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'playSound') beep();
});
