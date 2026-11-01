release: flask --app chalkback db upgrade
web: gunicorn "chalkback:create_app()" --workers 2 --bind 0.0.0.0:${PORT:-8000} --access-logfile -
