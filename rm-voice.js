"use strict";

/* Shared speech helper. Neural speech is server-proxied; browser speech remains the fallback. */
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
    let activeAudio = null;
    let activeObjectUrl = "";
    let playbackVersion = 0;
    let activeEndCallback = null;
    let pendingSpeech = null;

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

    function browserSpeechSupported() {
        return "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
    }

    function supported() {
        return typeof Audio !== "undefined" || browserSpeechSupported();
    }

    function pickVoice(lang) {
        if (!browserSpeechSupported()) { return null; }
        const voices = window.speechSynthesis.getVoices() || [];
        const base = lang.slice(0, 2).toLowerCase();
        const exact = voices.filter(function (voice) { return voice.lang.replace("_", "-").toLowerCase() === lang.toLowerCase(); });
        const loose = voices.filter(function (voice) { return voice.lang.toLowerCase().startsWith(base); });
        const pool = exact.length ? exact : loose;
        return pool.find(function (voice) { return BETTER_VOICE.test(voice.name); }) || pool[0] || null;
    }

    function csrfToken() {
        const match = document.cookie.match(/(?:^|; )rm_csrf=([^;]*)/);
        return match ? decodeURIComponent(match[1]) : "";
    }

    function releaseAudio() {
        if (activeAudio) {
            activeAudio.pause();
            activeAudio.removeAttribute("src");
            activeAudio.load();
            activeAudio = null;
        }
        if (activeObjectUrl) {
            URL.revokeObjectURL(activeObjectUrl);
            activeObjectUrl = "";
        }
    }

    function stop() {
        playbackVersion += 1;
        pendingSpeech = null;
        const finish = activeEndCallback;
        activeEndCallback = null;
        if (browserSpeechSupported()) {
            window.speechSynthesis.pause();
            window.speechSynthesis.cancel();
            window.speechSynthesis.resume();
        }
        releaseAudio();
        if (finish) { finish(); }
    }

    async function speak(text, options) {
        const config = options || {};
        const clean = String(text || "").replace(/\s+/g, " ").trim();
        if (!clean) { return false; }

        stop();
        const currentPlayback = playbackVersion;
        let finished = false;
        function finishPlayback() {
            if (finished) { return; }
            finished = true;
            if (activeEndCallback === finishPlayback) { activeEndCallback = null; }
            if (config.onEnd) { config.onEnd(); }
        }
        activeEndCallback = finishPlayback;
        if (config.endpoint) {
            try {
                const method = config.method || "POST";
                const headers = { Accept: "audio/mpeg", "X-CSRF-Token": csrfToken() };
                const request = {
                    method: method,
                    credentials: "same-origin",
                    cache: "no-store",
                    headers: headers,
                };
                if (config.token) {
                    headers["Content-Type"] = "application/json";
                    request.body = JSON.stringify({
                        text: clean,
                        token: config.token,
                        expiresAt: config.expiresAt,
                    });
                } else if (config.jsonText) {
                    headers["Content-Type"] = "application/json";
                    request.body = JSON.stringify({ text: clean });
                }
                const response = await fetch(config.endpoint, request);
                if (!response.ok) {
                    const problem = await response.json().catch(function () { return {}; });
                    throw new Error(problem.detail || "Neural speech is unavailable.");
                }
                const audioBlob = await response.blob();
                if (!audioBlob.size || !audioBlob.type.startsWith("audio/")) {
                    throw new Error("The speech service returned an invalid audio response.");
                }
                if (currentPlayback !== playbackVersion) { return false; }

                activeObjectUrl = URL.createObjectURL(audioBlob);
                const audio = new Audio(activeObjectUrl);
                audio.preload = "auto";
                audio.volume = 0.92;
                activeAudio = audio;
                let started = false;
                function finish() {
                    if (activeAudio === audio) { releaseAudio(); }
                    finishPlayback();
                }
                function announceStart() {
                    if (started) { return; }
                    started = true;
                    if (config.onStart) { config.onStart(); }
                }
                audio.addEventListener("playing", announceStart, { once: true });
                audio.addEventListener("ended", finish, { once: true });
                audio.addEventListener("error", finish, { once: true });
                await audio.play();
                if (currentPlayback !== playbackVersion) { return false; }
                announceStart();
                return true;
            } catch (error) {
                if (currentPlayback !== playbackVersion) { return false; }
                releaseAudio();
                console.warn("Neural speech unavailable; using browser speech synthesis.", error);
            }
        }

        if (!browserSpeechSupported()) {
            finishPlayback();
            return false;
        }
        const own = detectLanguage(clean);
        const lang = own !== FALLBACK ? own : lastQueryLang;
        const utterance = new SpeechSynthesisUtterance(clean);
        utterance.lang = lang;
        utterance.rate = lang === "bn-IN" ? 0.91 : 0.94;
        utterance.pitch = 1;
        utterance.volume = 0.92;
        const voice = pickVoice(lang);
        if (voice) { utterance.voice = voice; }
        if (config.onStart) { utterance.onstart = config.onStart; }
        utterance.onend = finishPlayback;
        utterance.onerror = finishPlayback;
        try {
            pendingSpeech = utterance;
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utterance);
        } catch (error) {
            finishPlayback();
            throw error;
        }
        return true;
    }

    function noteUserQuery(text) {
        const detected = detectLanguage(text);
        if (detected !== FALLBACK || /[a-z]/i.test(String(text || ""))) {
            lastQueryLang = detected;
        }
    }

    if (browserSpeechSupported()) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.addEventListener("voiceschanged", function () { window.speechSynthesis.getVoices(); });
    }

    function createButton(getText, options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rm-tts-btn";
        button.textContent = "\uD83D\uDD0A";
        button.setAttribute("aria-label", "Listen to this reply");
        button.title = "Listen";
        button.setAttribute("aria-pressed", "false");
        if (!supported()) { button.hidden = true; return button; }
        let playing = false;
        function reset() {
            playing = false;
            button.classList.remove("playing");
            button.setAttribute("aria-pressed", "false");
        }
        button.addEventListener("click", async function () {
            if (playing) { stop(); reset(); return; }
            playing = true;
            button.classList.add("playing");
            button.setAttribute("aria-pressed", "true");
            try {
                const started = await speak(getText(), Object.assign({}, options || {}, { onEnd: reset }));
                if (!started) { reset(); }
            } catch (error) {
                console.error("Speech playback failed.", error);
                reset();
            }
        });
        return button;
    }

    window.RMVoice = {
        detectLanguage: detectLanguage,
        speak: speak,
        stop: stop,
        noteUserQuery: noteUserQuery,
        createButton: createButton,
        supported: supported,
    };
}());
