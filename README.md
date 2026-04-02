# Bot de WhatsApp a Telegram para mensajes eliminados

Este proyecto crea un bot en Node.js que:

- Detecta mensajes eliminados para todos en WhatsApp.
- Guarda temporalmente multimedia asociada al mensaje.
- Envía un reporte detallado a Telegram usando Markdown.
- Mantiene la sesión de WhatsApp con autenticación local.
- Limpia automáticamente archivos temporales antiguos.

## Tecnologías

- `whatsapp-web.js`
- `Telegraf`
- `dotenv`
- `qrcode-terminal`

## Configuración

1. Instala dependencias:

```bash
npm install
```

2. Crea el archivo `.env` a partir de `.env.example`.

3. Configura estas variables:

- `TELEGRAM_BOT_TOKEN`: token del bot de Telegram.
- `TELEGRAM_CHAT_ID`: chat o grupo de Telegram que recibirá las alertas.
- `TEMP_MEDIA_DIR`: carpeta temporal para multimedia.
- `CLEANUP_INTERVAL_MINUTES`: cada cuánto correr la limpieza.
- `MEDIA_MAX_AGE_HOURS`: antigüedad máxima de multimedia antes de borrarla.

## Ejecución

```bash
npm start
```

Al iniciar por primera vez se mostrará un QR en consola para vincular WhatsApp Web. Luego la sesión quedará persistida con `LocalAuth`.

## Qué reporta a Telegram

- Nombre del contacto
- Número de teléfono
- Origen del mensaje: privado, grupo o estado
- Ubicación del chat
- Tipo de mensaje
- Hora de envío
- Hora de borrado
- Tiempo transcurrido antes del borrado
- Contenido del mensaje
- Estado de la captura multimedia

## Manejo de multimedia

Cuando el mensaje tiene multimedia, el bot intenta descargarla y guardarla en `TEMP_MEDIA_DIR`. Si la captura falla, el reporte lo indica claramente y el proceso continúa sin detener el bot.

## Limpieza automática

Los archivos temporales con más de 12 horas, o el tiempo configurado en `MEDIA_MAX_AGE_HOURS`, se eliminan automáticamente.
