# WhatsApp Delete Alert Bot - Versión Go

Bot de WhatsApp escrito en **Go** que detecta mensajes eliminados y los reporta a **Telegram**.

## Funcionamiento

- Monitorea la cuenta de WhatsApp usando la librería `whatsmeow` (API oficial no oficial de WhatsApp)
- Captura todos los mensajes nuevos y los almacena temporalmente en una caché en memoria
- Cuando alguien elimina un mensaje, el bot recupera su contenido desde la caché y envía un reporte detallado a un chat de Telegram
- El reporte incluye: remitente, hora, contenido original, tipo de mensaje y adjunta multimedia si la tenía
- Incluye botones interactivos en los mensajes de Telegram para abrir conversación y ver datos técnicos
- Limpieza automática de archivos temporales y caché

## Tecnologías

- **Lenguaje**: Go 1.21+
- **WhatsApp**: [whatsmeow](https://github.com/tulir/whatsmeow) - Biblioteca Go para WhatsApp Web
- **Telegram**: [go-telegram/bot](https://github.com/go-telegram/bot) - Cliente de Bot de Telegram
- **Almacenamiento**: SQLite para sesiones persistentes de WhatsApp
- **Configuración**: Variables de entorno con soporte para archivo `.env`

## Estructura del Proyecto

```
go-bot/
├── cmd/
│   └── main.go              # Punto de entrada principal
├── internal/
│   ├── cache/
│   │   └── cache.go         # Caché de mensajes y almacén de reportes
│   ├── config/
│   │   └── config.go        # Configuración y variables de entorno
│   ├── telegram/
│   │   └── bot.go           # Integración con Telegram
│   └── whatsapp/
│       └── client.go        # Integración con WhatsApp
├── pkg/
│   └── utils/
│       └── utils.go         # Utilidades comunes
├── go.mod                   # Dependencias de Go
└── go.sum                   # Sumas de verificación de dependencias
```

## Instalación

### Requisitos previos

- Go 1.21 o superior
- Token de bot de Telegram
- ID del chat de Telegram

### Pasos

1. Clona el repositorio y navega al directorio `go-bot`:
```bash
cd go-bot
```

2. Descarga las dependencias:
```bash
go mod download
```

3. Crea un archivo `.env` con tus credenciales:
```env
TELEGRAM_BOT_TOKEN=tu_token_de_telegram
TELEGRAM_CHAT_ID=tu_chat_id
TEMP_MEDIA_DIR=./tmp/media-cache
MESSAGE_CACHE_RETENTION_HOURS=6
MESSAGE_CACHE_MAX_ENTRIES=2000
```

4. Construye el proyecto:
```bash
go build -o whatsapp-bot ./cmd/main.go
```

5. Ejecuta el bot:
```bash
./whatsapp-bot
```

## Variables de Entorno

| Variable | Descripción | Valor por defecto |
|----------|-------------|-------------------|
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram (requerido) | - |
| `TELEGRAM_CHAT_ID` | ID del chat para enviar reportes (requerido) | - |
| `TEMP_MEDIA_DIR` | Directorio para archivos multimedia temporales | `./tmp/media-cache` |
| `CLEANUP_INTERVAL_MINUTES` | Intervalo de limpieza de archivos (minutos) | `15` |
| `MEDIA_MAX_AGE_HOURS` | Edad máxima de archivos multimedia (horas) | `6` |
| `MESSAGE_CACHE_RETENTION_HOURS` | Retención de caché de mensajes (horas) | `6` |
| `MESSAGE_CACHE_MAX_ENTRIES` | Máximo de entradas en caché | `2000` |
| `REPORT_STORE_RETENTION_HOURS` | Retención de reportes (horas) | `12` |
| `REPORT_STORE_MAX_ENTRIES` | Máximo de reportes almacenados | `50` |

## Características

- ✅ Detección de mensajes eliminados en chats privados, grupos y estados
- ✅ Captura de multimedia (imágenes, videos, audios, documentos, stickers)
- ✅ Sesión persistente de WhatsApp (no requiere escanear QR en cada reinicio)
- ✅ Reportes formatados en HTML para Telegram
- ✅ Botones interactivos para ver datos técnicos y abrir WhatsApp
- ✅ Limpieza automática de caché y archivos temporales
- ✅ Manejo seguro de cierre (SIGINT, SIGTERM)

## Comparación con la versión JavaScript

| Característica | JavaScript (Node.js) | Go |
|----------------|---------------------|-----|
| Librería WhatsApp | whatsapp-web.js (Puppeteer) | whatsmeow (nativa) |
| Librería Telegram | telegraf | go-telegram/bot |
| Consumo de memoria | Alto (Chromium) | Bajo |
| Rendimiento | Bueno | Excelente |
| Dependencias externas | Chromium, Node.js | Ninguna (binario estático) |
| Tamaño | ~200MB+ | ~15MB |

## Notas

- La primera ejecución mostrará un código QR para escanear con WhatsApp
- Las sesiones se guardan en SQLite automáticamente
- El bot necesita conexión a internet para funcionar
- No uses este bot para violar la privacidad de otros

## Licencia

MIT
