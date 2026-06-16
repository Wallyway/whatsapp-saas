/**
 * Audio transcription service — F8-D1 stub.
 *
 * Full Whisper transcription via Groq/OpenRouter requires multipart form
 * upload (download from Supabase Storage → POST to audio/transcriptions
 * endpoint). This is deferred to v1.5 per Blueprint §Fases futuras.
 *
 * The buffer.ts consolidation already handles non-transcribed audio as
 * '[Multimedia]', so returning null here is safe for the AI agent context.
 *
 * TODO v1.5 — full implementation outline:
 *   1. getSignedUrl(storagePath) → download audio bytes
 *   2. Build FormData with file blob + model='whisper-large-v3'
 *   3. POST to https://api.groq.com/openai/v1/audio/transcriptions
 *      (or OpenRouter equivalent when available)
 *   4. Return transcription.text
 */

export interface TranscribeAudioOptions {
  /** Path in whatsapp-media Supabase Storage bucket */
  storagePath: string;
  /** OpenRouter (or Groq) API key */
  apiKey: string;
}

/**
 * Transcribes an audio file stored in Supabase Storage.
 *
 * Returns null — full Whisper integration is scheduled for v1.5.
 * The caller (media-handler / buffer consolidation) must handle null gracefully.
 */
export async function transcribeAudio(
  _opts: TranscribeAudioOptions,
): Promise<string | null> {
  // v1.5: implement Groq Whisper multipart upload here
  return null;
}
