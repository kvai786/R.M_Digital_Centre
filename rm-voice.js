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
    const FALLBACK = "en-IN";
    const BETTER_VOICE = /google|natural|neural|online|enhanced|premium/i;
    let lastQueryLang = FALLBACK;
    let activeAudio = null;
    let activeObjectUrl = "";
    let playbackVersion = 0;
    let activeEndCallback = null;
    let pendingSpeech = null;
    let activeMicrophone = null;

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
        const loose = voices.filter(function (voice) {
            return voice.lang.replace("_", "-").toLowerCase().split("-")[0] === base;
        });
        const pool = exact.length ? exact : loose;
        return pool.find(function (voice) { return BETTER_VOICE.test(voice.name); }) || pool[0] || null;
    }

    function waitForVoices() {
        const synthesis = window.speechSynthesis;
        if (synthesis.getVoices().length) { return Promise.resolve(); }
        return new Promise(function (resolve) {
            const timer = window.setTimeout(finish, 1000);
            function finish() {
                window.clearTimeout(timer);
                synthesis.removeEventListener("voiceschanged", finish);
                resolve();
            }
            synthesis.addEventListener("voiceschanged", finish);
            if (synthesis.getVoices().length) { finish(); }
        });
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

        if (activeMicrophone) { activeMicrophone.cancel(); }
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
        await waitForVoices();
        if (currentPlayback !== playbackVersion) { return false; }
        const own = detectLanguage(clean);
        const lang = own !== FALLBACK || /[a-z]/i.test(clean) ? own : lastQueryLang;
        const utterance = new SpeechSynthesisUtterance(clean);
        utterance.lang = lang;
        utterance.rate = lang === "bn-IN" ? 0.91 : 0.94;
        utterance.pitch = 1;
        utterance.volume = 0.92;
        const voice = pickVoice(lang);
        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
        }
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
        let buttonVersion = 0;
        function reset(version) {
            if (version !== buttonVersion) { return; }
            playing = false;
            button.classList.remove("playing");
            button.setAttribute("aria-pressed", "false");
        }
        button.addEventListener("click", async function () {
            if (playing) { stop(); return; }
            const version = ++buttonVersion;
            playing = true;
            button.classList.add("playing");
            button.setAttribute("aria-pressed", "true");
            try {
                const started = await speak(getText(), Object.assign({}, options || {}, {
                    onEnd: function () { reset(version); },
                }));
                if (!started) { reset(version); }
            } catch (error) {
                console.error("Speech playback failed.", error);
                reset(version);
            }
        });
        return button;
    }

    function createInput(input) {
        const container = document.createElement("div");
        container.className = "rm-voice-input";
        const language = document.createElement("select");
        language.setAttribute("aria-label", "Voice input language");
        [["bn-IN", "Bengali"], ["hi-IN", "Hindi"], ["en-IN", "English"]].forEach(function (choice) {
            const option = document.createElement("option");
            option.value = choice[0];
            option.textContent = choice[1];
            language.append(option);
        });
        const browserLanguage = String(navigator.language || "").toLowerCase();
        language.value = browserLanguage.startsWith("bn") ? "bn-IN" :
            browserLanguage.startsWith("hi") ? "hi-IN" : "en-IN";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Mic";
        button.setAttribute("aria-label", "Start voice input");
        button.setAttribute("aria-pressed", "false");
        const status = document.createElement("span");
        status.className = "rm-voice-status";
        status.setAttribute("role", "status");
        const notice = document.createElement("small");
        notice.textContent = "Voice input may be processed by your browser provider.";
        container.append(language, button, status, notice);

        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        let recognition = null;
        let failed = false;
        const control = {
            element: container,
            cancel: function () {
                if (!recognition) { return; }
                const current = recognition;
                reset(current);
                try { current.abort(); } catch (error) { console.warn("Could not stop voice input.", error); }
                status.textContent = "Voice input stopped.";
            },
        };

        function reset(current) {
            if (recognition !== current) { return; }
            recognition = null;
            if (activeMicrophone === control) { activeMicrophone = null; }
            button.disabled = !Recognition;
            button.textContent = "Mic";
            button.setAttribute("aria-label", "Start voice input");
            button.setAttribute("aria-pressed", "false");
            language.disabled = false;
        }

        if (!Recognition) {
            button.disabled = true;
            language.disabled = true;
            status.textContent = "Voice input is not supported in this browser.";
            return control;
        }

        input.addEventListener("input", function () {
            if (recognition) {
                control.cancel();
                status.textContent = "Voice input stopped; continue typing.";
            }
        });
        button.addEventListener("click", function () {
            if (recognition) {
                button.disabled = true;
                status.textContent = "Finishing voice input...";
                try { recognition.stop(); } catch (error) {
                    console.warn("Could not finish voice input.", error);
                    control.cancel();
                    status.textContent = "Could not finish voice input. Please try again.";
                }
                return;
            }
            if (activeMicrophone) { activeMicrophone.cancel(); }
            stop();
            const prefix = input.value.trim();
            let current;
            try { current = new Recognition(); } catch (error) {
                console.warn("Could not create voice input.", error);
                status.textContent = "Could not start voice input. Please try again.";
                return;
            }
            recognition = current;
            activeMicrophone = control;
            failed = false;
            current.lang = language.value;
            current.continuous = true;
            current.interimResults = true;
            current.maxAlternatives = 1;
            button.textContent = "Stop";
            button.setAttribute("aria-label", "Stop voice input");
            button.setAttribute("aria-pressed", "true");
            language.disabled = true;
            status.textContent = "Listening...";
            current.onresult = function (event) {
                if (recognition !== current) { return; }
                const parts = [];
                for (let i = 0; i < event.results.length; i += 1) {
                    if (event.results[i][0]) { parts.push(event.results[i][0].transcript.trim()); }
                }
                const text = [prefix].concat(parts).filter(Boolean).join(" ");
                input.value = input.maxLength > 0 ? text.slice(0, input.maxLength) : text;
            };
            current.onerror = function (event) {
                if (recognition !== current) { return; }
                failed = true;
                console.warn("Voice input failed:", event.error);
                control.cancel();
                status.textContent = event.error === "not-allowed" || event.error === "service-not-allowed"
                    ? "Microphone permission denied. Check your browser settings."
                    : "Voice input failed (" + event.error + "). Please try again.";
            };
            current.onend = function () {
                if (recognition !== current) { return; }
                reset(current);
                if (!failed) { status.textContent = "Voice input finished. Review your message before sending."; }
            };
            try { current.start(); } catch (error) {
                console.warn("Could not start voice input.", error);
                reset(current);
                status.textContent = "Could not start voice input. Please try again.";
            }
        });
        return control;
    }

    window.RMVoice = {
        detectLanguage: detectLanguage,
        speak: speak,
        stop: stop,
        noteUserQuery: noteUserQuery,
        createButton: createButton,
        createInput: createInput,
        supported: supported,
    };
}());
