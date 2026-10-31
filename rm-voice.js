"use strict";

/* Shared text-to-speech helper for the chat assistants. Uses only the browser SpeechSynthesis API. */
(function () {
    const SCRIPTS = [
        [/[\u0980-\u09FF]/g, "bn-IN"],
        [/[\u0900-\u097F]/g, "hi-IN"],
        [/[\u0B80-\u0BFF]/g, "ta-IN"],
        [/[\u0C00-\u0C7F]/g, "te-IN"],
        [/[\u0A80-\u0AFF]/g, "gu-IN"],
        [/[\u0A00-\u0A7F]/g, "pa-IN"],
        [/[\u0C80-\u0CFF]/g, "kn-IN"],
        [/[\u0D00-\u0D7F]/g, "ml-IN"],
        [/[\u0B00-\u0B7F]/g, "or-IN"],
        [/[\u0600-\u06FF]/g, "ur-PK"],
    ];
    const FALLBACK = "en-US";
    const BETTER_VOICE = /google|natural|neural|online|enhanced|premium/i;
    let lastQueryLang = FALLBACK;

    function detectLanguage(text) {
        const value = String(text || "");
        let best = FALLBACK;
        let bestCount = 0;
        SCRIPTS.forEach(function (entry) {
            const matches = value.match(entry[0]);
            if (matches && matches.length > bestCount) { best = entry[1]; bestCount = matches.length; }
        });
        return best;
    }

    function supported() {
        return "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
    }

    function pickVoice(lang) {
        const voices = window.speechSynthesis.getVoices() || [];
        const base = lang.slice(0, 2).toLowerCase();
        const exact = voices.filter(function (voice) { return voice.lang.replace("_", "-").toLowerCase() === lang.toLowerCase(); });
        const loose = voices.filter(function (voice) { return voice.lang.toLowerCase().startsWith(base); });
        const pool = exact.length ? exact : loose;
        return pool.find(function (voice) { return BETTER_VOICE.test(voice.name); }) || pool[0] || null;
    }

    function stop() {
        if (supported()) { window.speechSynthesis.cancel(); }
    }

    /* Language follows the reply's own script; a Latin-script reply uses the language of the user's last question. */
    function speak(text, onEnd) {
        const clean = String(text || "").replace(/\s+/g, " ").trim();
        if (!supported() || !clean) { return false; }
        const own = detectLanguage(clean);
        const lang = own !== FALLBACK ? own : lastQueryLang;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(clean);
        utterance.lang = lang;
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;
        const voice = pickVoice(lang);
        if (voice) { utterance.voice = voice; }
        if (onEnd) { utterance.onend = onEnd; utterance.onerror = onEnd; }
        window.speechSynthesis.speak(utterance);
        return true;
    }

    function noteUserQuery(text) {
        lastQueryLang = detectLanguage(text);
    }

    /* Voices load asynchronously in some browsers; touching the list early lets pickVoice find them later. */
    if (supported()) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.addEventListener("voiceschanged", function () { window.speechSynthesis.getVoices(); });
    }

    function createButton(getText) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rm-tts-btn";
        button.textContent = "\uD83D\uDD0A";
        button.setAttribute("aria-label", "Listen to this reply");
        button.title = "Listen";
        if (!supported()) { button.hidden = true; return button; }
        let playing = false;
        function reset() { playing = false; button.classList.remove("playing"); button.setAttribute("aria-pressed", "false"); }
        button.addEventListener("click", function () {
            if (playing) { stop(); reset(); return; }
            playing = speak(getText(), reset);
            if (playing) { button.classList.add("playing"); button.setAttribute("aria-pressed", "true"); }
        });
        return button;
    }

    window.RMVoice = { detectLanguage: detectLanguage, speak: speak, stop: stop, noteUserQuery: noteUserQuery, createButton: createButton, supported: supported };
})();
