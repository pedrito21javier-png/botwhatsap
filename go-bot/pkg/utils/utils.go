package utils

import (
	"fmt"
	"html"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var messageTypeLabels = map[string]string{
	"audio":    "Audio",
	"chat":     "Texto",
	"document": "Documento",
	"image":    "Imagen",
	"location": "Ubicacion",
	"ptt":      "Nota de voz",
	"reaction": "Reaccion",
	"revoked":  "Revocado",
	"sticker":  "Sticker",
	"video":    "Video",
	"vcard":    "Contacto",
}

func EscapeHTML(value string) string {
	return html.EscapeString(value)
}

func FormatTimestamp(timestampSeconds int64) string {
	if timestampSeconds == 0 {
		return "Desconocida"
	}
	t := time.Unix(timestampSeconds, 0)
	return t.Format("02/01/2006 15:04:05")
}

func FormatElapsed(ms int64) string {
	if ms < 0 {
		return "No disponible"
	}

	totalSeconds := ms / 1000
	hours := totalSeconds / 3600
	minutes := (totalSeconds % 3600) / 60
	seconds := totalSeconds % 60

	parts := []string{}
	if hours > 0 {
		parts = append(parts, fmt.Sprintf("%dh", hours))
	}
	if minutes > 0 {
		parts = append(parts, fmt.Sprintf("%dm", minutes))
	}
	parts = append(parts, fmt.Sprintf("%ds", seconds))
	return strings.Join(parts, " ")
}

func TruncateText(value string, maxLength int) string {
	if len(value) <= maxLength {
		return value
	}
	if maxLength <= 3 {
		return ""
	}
	return value[:maxLength-3] + "..."
}

func SanitizeFileName(input string) string {
	reg := regexp.MustCompile(`[^a-zA-Z0-9._-]`)
	return reg.ReplaceAllString(input, "_")
}

func CleanText(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	return text
}

func DigitsOnly(value string) string {
	reg := regexp.MustCompile(`\D`)
	digits := reg.ReplaceAllString(value, "")
	if digits == "" {
		return ""
	}
	return digits
}

func FormatMessageType(msgType string) string {
	if label, exists := messageTypeLabels[msgType]; exists {
		return label
	}
	if msgType == "" {
		return "Desconocido"
	}
	return msgType
}

func ResolveDisplayName(contactName, pushName, shortName, phoneNumber string) (displayName, nickName, nameSource string) {
	contactName = CleanText(contactName)
	pushName = CleanText(pushName)
	shortName = CleanText(shortName)

	nickName = FirstNonEmpty(pushName, shortName)

	if contactName != "" {
		return contactName, nickName, "contacto_guardado"
	}

	if nickName != "" {
		return nickName, nickName, "nick_whatsapp"
	}

	if phoneNumber != "" {
		return phoneNumber, "", "numero"
	}

	return "Desconocido", "", "desconocido"
}

func FormatNameSource(source string) string {
	labels := map[string]string{
		"contacto_guardado": "Contacto guardado",
		"nick_whatsapp":     "Nick de WhatsApp",
		"numero":            "Numero telefonico",
		"desconocido":       "No disponible",
	}

	if label, exists := labels[source]; exists {
		return label
	}
	if source == "" {
		return "No disponible"
	}
	return source
}

func GetLocationDetails(originType, chatName string) string {
	if originType == "Grupo" {
		if chatName == "" {
			return "Grupo sin nombre"
		}
		return chatName
	}

	if originType == "Estado" {
		return "Estado"
	}

	return "Chat privado"
}

func GetMediaStatus(hasMedia bool, mediaInfo *MediaInfoWrapper) string {
	if !hasMedia {
		return "Sin multimedia"
	}

	if mediaInfo != nil && mediaInfo.Error != "" {
		return fmt.Sprintf("No capturada: %s", mediaInfo.Error)
	}

	if mediaInfo != nil && mediaInfo.FileName != "" {
		return fmt.Sprintf("Capturada: %s", mediaInfo.FileName)
	}

	return "Capturada: archivo temporal"
}

type MediaInfoWrapper struct {
	FilePath string
	FileName string
	Error    string
}

func BuildWhatsAppChatUrl(authorPhoneNumber string) string {
	phone := DigitsOnly(authorPhoneNumber)
	if phone == "" {
		return ""
	}
	return fmt.Sprintf("https://wa.me/%s", phone)
}

func FormatClockFromMs(ms int64) string {
	t := time.UnixMilli(ms)
	return t.Format("15:04:05")
}

func FirstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func ParseIntOrDefault(value string, defaultValue int) int {
	if value == "" {
		return defaultValue
	}
	result, err := strconv.Atoi(value)
	if err != nil {
		return defaultValue
	}
	return result
}

func JoinPath(base, elem ...string) string {
	return filepath.Join(append([]string{base}, elem...)...)
}
