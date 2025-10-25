document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start');
  const apiKeyEl = document.getElementById('apiKey');
  const modeEl = document.getElementById('mode');

  // restore saved key
  chrome.storage.local.get(['openai_key'], (res) => {
    if (res.openai_key) apiKeyEl.value = res.openai_key;
  });

  startBtn.addEventListener('click', async () => {
    const apiKey = apiKeyEl.value.trim();
    const mode = modeEl.value;

    if (!apiKey) {
      alert("Masukkan OpenAI API Key (untuk generate jawaban).");
      return;
    }

    // save key (local extension storage)
    chrome.storage.local.set({ openai_key: apiKey });

    // send message to content script in active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      alert("Tidak ada tab aktif.");
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'autofill_start', mode }, (response) => {
      if (chrome.runtime.lastError) {
        alert("Gagal menghubungi content script. Pastikan kamu berada di halaman Google Forms.");
      } else {
        alert(response?.message || "Permintaan dikirim ke content script.");
      }
    });
  });
}); 