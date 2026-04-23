package config

import (
	"os"
	"strconv"
)

type Config struct {
	TelegramBotToken           string
	TelegramChatID             string
	TempMediaDir               string
	WWebJSAuthDir              string
	CleanupIntervalMinutes     int
	MediaMaxAgeHours           int
	MessageCacheRetentionHours int
	MessageCacheMaxEntries     int
	ReportStoreRetentionHours  int
	ReportStoreMaxEntries      int
}

func Load() (*Config, error) {
	requiredVars := []string{"TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"}
	for _, envKey := range requiredVars {
		if os.Getenv(envKey) == "" {
			return nil, &MissingEnvVarError{Key: envKey}
		}
	}

	cleanupIntervalMinutes, _ := strconv.Atoi(getEnvOrDefault("CLEANUP_INTERVAL_MINUTES", "15"))
	mediaMaxAgeHours, _ := strconv.Atoi(getEnvOrDefault("MEDIA_MAX_AGE_HOURS", "6"))
	messageCacheRetentionHours, _ := strconv.Atoi(getEnvOrDefault("MESSAGE_CACHE_RETENTION_HOURS", "6"))
	messageCacheMaxEntries, _ := strconv.Atoi(getEnvOrDefault("MESSAGE_CACHE_MAX_ENTRIES", "2000"))
	reportStoreRetentionHours, _ := strconv.Atoi(getEnvOrDefault("REPORT_STORE_RETENTION_HOURS", "12"))
	reportStoreMaxEntries, _ := strconv.Atoi(getEnvOrDefault("REPORT_STORE_MAX_ENTRIES", "50"))

	return &Config{
		TelegramBotToken:           os.Getenv("TELEGRAM_BOT_TOKEN"),
		TelegramChatID:             os.Getenv("TELEGRAM_CHAT_ID"),
		TempMediaDir:               getEnvOrDefault("TEMP_MEDIA_DIR", "./tmp/media-cache"),
		WWebJSAuthDir:              getEnvOrDefault("WWEBJS_AUTH_DIR", "./.wwebjs_auth"),
		CleanupIntervalMinutes:     cleanupIntervalMinutes,
		MediaMaxAgeHours:           mediaMaxAgeHours,
		MessageCacheRetentionHours: messageCacheRetentionHours,
		MessageCacheMaxEntries:     messageCacheMaxEntries,
		ReportStoreRetentionHours:  reportStoreRetentionHours,
		ReportStoreMaxEntries:      reportStoreMaxEntries,
	}, nil
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

type MissingEnvVarError struct {
	Key string
}

func (e *MissingEnvVarError) Error() string {
	return "Falta la variable de entorno obligatoria: " + e.Key
}
