(async function() {
  console.log("[AutoFill] content script loaded");

  // helper: kirim request ke OpenAI (mengambil API key dari storage)
  async function askOpenAI(prompt) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['openai_key'], async (res) => {
        const key = res.openai_key;
        if (!key) return reject("No API key stored in extension.");

        try {
          const body = {
            model: "gpt-4o-mini", // placeholder — ganti sesuai aksesmu
            messages: [{ role: "user", content: prompt }],
            max_tokens: 200
          };

          const r = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${key}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          });

          if (!r.ok) {
            const txt = await r.text();
            return reject("OpenAI error: " + txt);
          }

          const j = await r.json();
          const reply = j.choices?.[0]?.message?.content || "";
          resolve(reply.trim());
        } catch (err) {
          reject(err.toString());
        }
      });
    });
  }

  // heuristik dapatkan list item (pertanyaan)
  function getQuestions() {
    // role=listitem sering digunakan untuk setiap pertanyaan
    const items = Array.from(document.querySelectorAll('[role="listitem"]'));
    // fallback: cari elemen yang berisi class 'freebirdFormviewerViewItemsItemItem'
    if (!items.length) {
      const fallback = Array.from(document.querySelectorAll('div[class*="freebirdFormviewerViewItemsItem"]'));
      return fallback;
    }
    return items;
  }

  // ambil teks pertanyaan dari item
  function extractQuestionText(item) {
    // heuristik: cari elemen berisi teks judul
    const title = item.querySelector('.freebirdFormviewerComponentsQuestionBaseTitle, .M7eMe') ||
                  item.querySelector('[role="heading"]') ||
                  item.querySelector('.freebirdFormviewerViewItemsItemItemTitle') ||
                  item.querySelector('.freebirdFormviewerViewItemsItemItemTitleExport');
    if (title) return title.innerText.trim();
    // fallback: gabungkan teks si item
    return item.innerText.split("\n").slice(0,2).join(" ").trim();
  }

  // temukan input type dalam item: text, textarea, radios, checkboxes, select
  function detectInputs(item) {
    const textInput = item.querySelector('input[type="text"], input[type="email"], input[type="tel"], textarea');
    if (textInput) return { type: "text", el: textInput };

    // radio group - opsi biasanya dalam role="radiogroup" atau elements with aria-checked
    const radioGroup = item.querySelector('[role="radiogroup"], div[role="list"]') || null;
    if (radioGroup) {
      const options = Array.from(item.querySelectorAll('div[role="radio"], .appsMaterialWizToggleRadiogroupRadio, .docssharedWizToggleLabeledContainer'));
      const labels = options.map(o => {
        // opsi label text
        return {
          el: o,
          text: (o.innerText || "").trim()
        };
      }).filter(x => x.text);
      if (labels.length) return { type: "radio", options: labels };
    }

    // checkbox list
    const checkboxes = Array.from(item.querySelectorAll('div[role="checkbox"], .quantumWizTogglePapercheckboxEl'));
    if (checkboxes.length) {
      return { type: "checkbox", options: checkboxes.map(o => ({ el: o, text: (o.innerText||"").trim() })) };
    }

    // dropdown/select (rare)
    const select = item.querySelector('select');
    if (select) {
      const opts = Array.from(select.options).map(o => ({ value: o.value, text: o.innerText }));
      return { type: "select", el: select, options: opts };
    }

    return { type: "unknown" };
  }

  // klik elemen opsi (radiobutton/checkbox) — beberapa opsi butuh klik parent
  function clickOption(optionEl) {
    try {
      optionEl.click();
    } catch(e) {
      // fallback trigger events
      optionEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }

  // isi satu pertanyaan berdasarkan jawaban text
  async function fillOne(item, mode) {
    const qtext = extractQuestionText(item);
    const inputInfo = detectInputs(item);

    // buat prompt untuk LLM — sertakan opsi jika ada
    let prompt = `Beri jawaban yang SINGKAT dan TEPAT untuk pertanyaan survei berikut (jawaban sebaiknya cocok untuk form, tanpa tambahan penjelasan):\n\nPertanyaan: ${qtext}\n\n`;
    if (inputInfo.type === 'radio' && inputInfo.options && inputInfo.options.length) {
      prompt += 'Pilihan yang tersedia:\n';
      inputInfo.options.forEach((o, i) => prompt += `${i+1}. ${o.text}\n`);
      prompt += '\nPilih nomor opsi terbaik (atau tulis opsi lengkap).';
    } else if (inputInfo.type === 'checkbox' && inputInfo.options && inputInfo.options.length) {
      prompt += 'Pilihan (centang) yang tersedia:\n';
      inputInfo.options.forEach((o,i) => prompt += `${i+1}. ${o.text}\n`);
      prompt += '\nPilih satu atau beberapa nomor yang relevan (pisahkan dengan koma) atau tulis jawaban singkat.';
    } else {
      prompt += 'Berikan jawaban singkat yang relevan.';
    }

    // call LLM
    let answer;
    try {
      answer = await askOpenAI(prompt);
    } catch (err) {
      console.error("LLM error:", err);
      answer = ""; // fallback: kosong
    }

    if (!answer) return { filled: false, reason: "no answer from LLM" };

    // isi berdasarkan tipe
    if (inputInfo.type === 'text') {
      const el = inputInfo.el;
      el.focus();
      el.value = answer;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      return { filled: true };
    } else if (inputInfo.type === 'radio') {
      // temukan opsi yang cocok (cari substring)
      const lowerAns = answer.toLowerCase();
      // cari exact match di opsi text
      let chosen = null;
      for (const opt of inputInfo.options) {
        if (opt.text.toLowerCase().includes(lowerAns) || lowerAns.includes(opt.text.toLowerCase())) {
          chosen = opt;
          break;
        }
      }
      // jika belum, coba berdasarkan nomor dari jawaban
      const m = answer.match(/\d+/);
      if (!chosen && m) {
        const idx = parseInt(m[0],10) - 1;
        if (idx >=0 && idx < inputInfo.options.length) chosen = inputInfo.options[idx];
      }
      // fallback: ambil opsi pertama
      if (!chosen) chosen = inputInfo.options[0];

      clickOption(chosen.el);
      return { filled: true, chosen: chosen.text || null };
    } else if (inputInfo.type === 'checkbox') {
      // kalau LLM menjawab angka-angka, centang yang sesuai
      const nums = answer.match(/\d+/g);
      if (nums && nums.length) {
        nums.forEach(n => {
          const idx = parseInt(n,10)-1;
          if (idx>=0 && idx < inputInfo.options.length) clickOption(inputInfo.options[idx].el);
        });
        return { filled: true };
      }
      // kalau LLM jawab teks yang cocok dengan opsi
      const lower = answer.toLowerCase();
      inputInfo.options.forEach(opt => {
        if (opt.text.toLowerCase().includes(lower) || lower.includes(opt.text.toLowerCase())) {
          clickOption(opt.el);
        }
      });
      return { filled: true };
    } else if (inputInfo.type === 'select') {
      // pilih opsi yang paling cocok
      const lowerAns = answer.toLowerCase();
      let chosenIdx = 0;
      for (let i=0;i<inputInfo.options.length;i++) {
        if (inputInfo.options[i].text.toLowerCase().includes(lowerAns) || lowerAns.includes(inputInfo.options[i].text.toLowerCase())) {
          chosenIdx = i; break;
        }
      }
      inputInfo.el.selectedIndex = chosenIdx;
      inputInfo.el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true };
    } else {
      return { filled: false, reason: 'unknown input type' };
    }
  }

  // handle message dari popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
    if (msg?.action === 'autofill_start') {
      (async () => {
        const mode = msg.mode || 'suggest';
        const items = getQuestions();
        if (!items.length) {
          sendResp({ message: "Tidak menemukan pertanyaan (bukan halaman Google Forms?)." });
          return;
        }
        // proses semua pertanyaan satu-per-satu
        const results = [];
        for (let i=0;i<items.length;i++) {
          try {
            const res = await fillOne(items[i], mode);
            results.push({ index: i, result: res });
            // beri jeda kecil agar tidak spam request
            await new Promise(r => setTimeout(r, 500));
          } catch (e) {
            console.error(e);
            results.push({ index: i, error: e.toString() });
          }
        }

        // mode submit jika diminta
        if (mode === 'fill_and_submit') {
          // cari tombol submit (heuristik)
          const submitBtn = Array.from(document.querySelectorAll('div[role="button"], button')).find(b => /submit|kirim/i.test(b.innerText));
          if (submitBtn) {
            submitBtn.click();
          } else {
            console.warn("Submit button not found.");
          }
        }

        sendResp({ message: `Selesai mengisi ${results.length} pertanyaan. Periksa halaman.` });
      })();

      // must return true to indicate sendResp will be called asynchronously
      return true;
    }
  });
})();