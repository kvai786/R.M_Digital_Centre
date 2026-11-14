# Neural voice configuration

The portal can synthesize assistant speech through ElevenLabs. The API key and voice IDs are read only by the server; do not put them in browser code or commit their values.

Configure these environment variables in the server deployment:

- `ELEVENLABS_API_KEY` — ElevenLabs API key.
- `ELEVENLABS_VOICE_ID` — voice ID to use for English and as the Bengali fallback.
- `ELEVENLABS_BENGALI_VOICE_ID` — optional voice ID for Bengali replies.
- `CSRF_SECRET` — stable, high-entropy secret shared by all application workers. It signs short-lived public speech tokens; rotating it invalidates issued tokens.

The server uses the `eleven_v4` model and requests bounded MP3 audio. Public speech tokens are limited to the exact reply, client IP, and a 90-second expiration. Public speech is limited to 5 requests per client IP per minute; owner speech is limited to 5 per owner per minute, with a shared service ceiling of 30 per minute.

If ElevenLabs is not configured or is temporarily unavailable, the browser helper falls back to the device's built-in speech synthesis when available. The owner greeting endpoint remains restricted to an authenticated Super Admin session.
