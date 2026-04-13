module.exports = {
  apps: [
    {
      name: 'whatsapp-delete-alert-bot',
      script: 'src/index.js',
      max_memory_restart: '750M',
      env: {
        NODE_ENV: 'production',
        CLEANUP_INTERVAL_MINUTES: '15',
        MEDIA_MAX_AGE_HOURS: '6',
        MESSAGE_CACHE_RETENTION_HOURS: '6',
        MESSAGE_CACHE_MAX_ENTRIES: '2000',
        REPORT_STORE_RETENTION_HOURS: '12',
        REPORT_STORE_MAX_ENTRIES: '50',
        TEMP_MEDIA_DIR: './tmp/media-cache',
        WWEBJS_AUTH_DIR: './.wwebjs_auth'
      }
    }
  ]
};
