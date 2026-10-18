# DJ Peligro playback architecture

Objetivo: separar responsabilidades para que la reproducción sea estable y la radio inteligente no interfiera con la canción actual.

## 1. PlaybackEngine

Solo reproduce la canción actual.

Responsabilidades:
- Maneja FFmpeg.
- Maneja retry temprano 403 -> m4a.
- Maneja Playing / Idle / error.
- Maneja stop / skip / previous desde el punto de vista del playback.
- No prepara radio.
- No hace probe previo de canciones manuales.
- No debe depender de que la radio esté lista para reproducir una canción manual.

## 2. QueueManager

Decide qué canción viene después.

Prioridad estricta:
1. manualQueue
2. pendingPostPreviousNextSong
3. verifiedRadioQueue
4. nada más

Responsabilidades:
- Elegir la próxima canción.
- No resolver transportes.
- No hacer yt-dlp.
- No hacer FFmpeg probe.
- No reproducir directamente.

## 3. RadioRecommender

Solo busca canciones parecidas.

Responsabilidades:
- Usar ytmusicapi / ytmusic_radio.py.
- Generar candidatas de radio inteligentes.
- Aplicar filtros de calidad de radio.
- No reproducir.
- No tocar FFmpeg.
- No tocar la canción actual.

## 4. TransportResolver

Solo resuelve transportes con yt-dlp.

Responsabilidades:
- Ejecutar yt-dlp.
- Devolver:
  - URL
  - headers
  - format_id
  - ext
  - protocol
  - title
- No reproducir.
- No decidir cola.
- No hacer política de radio.

## 5. TransportVerifier

Solo prueba transportes de radio.

Responsabilidades:
- Hacer FFmpeg probe corto.
- Usarse solo para candidatas de radio.
- Si falla, descarta la candidata.
- Si pasa, entrega un transporte listo.
- Nunca probar la canción manual actual.
- Nunca bloquear un pedido manual.

## 6. VerifiedRadioQueue

Cola separada de radio verificada.

Reglas:
- Máximo 2 canciones.
- Cada entrada contiene:
  - song
  - ytDlpResult probado
- Solo entran canciones que pasaron:
  - RadioRecommender
  - TransportResolver
  - TransportVerifier
- El playback puede consumir esta cola sin volver a validar.
- Si está vacía, el bot espera/genera radio, pero no reproduce canciones no verificadas.

## 7. PreviousCache

Cache de transportes recientes para volver rápido.

Responsabilidades:
- Guardar transportes recientes.
- Usarse solo para previous.
- No preparar radio.
- No tocar manualQueue.
- No modificar verifiedRadioQueue.

## Reglas de oro

- La reproducción nunca depende del preparador.
- El preparador nunca toca la canción actual.
- La radio nunca entra si no está verificada.
- Manual nunca se bloquea por probe.
- Previous usa cache, pero no modifica radio.
- No usar el transportPreloadBuffer general para probe pesado.
- No hacer probe durante intro.
- No hacer probe durante retry.
- No cambiar FFmpeg/headers de la base sana sin una prueba aislada.
