import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get(
    "DJANGO_SECRET_KEY",
    "development-only-change-me-before-deployment",
)
DEBUG = os.environ.get("DJANGO_DEBUG", "0") == "1"
ALLOWED_HOSTS = [
    host.strip()
    for host in os.environ.get(
        "DJANGO_ALLOWED_HOSTS",
        "localhost,127.0.0.1,testserver",
    ).split(",")
    if host.strip()
]

INSTALLED_APPS = ["greetings.apps.GreetingsConfig"]
MIDDLEWARE: list[str] = []
ROOT_URLCONF = "greeting_project.urls"
TEMPLATES: list[dict[str, object]] = []
WSGI_APPLICATION = "greeting_project.wsgi.application"
ASGI_APPLICATION = "greeting_project.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": os.environ.get("DJANGO_DB_PATH", str(BASE_DIR / "db.sqlite3")),
        "TEST": {"NAME": ":memory:"},
    }
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True

# Use a local or staging ingest endpoint while running this example.
TRAFFICWAR_API_KEY = os.environ.get("TRAFFICWAR_API_KEY", "")
TRAFFICWAR_BASE_URL = os.environ.get(
    "TRAFFICWAR_BASE_URL",
    "http://127.0.0.1:47317",
)
TRAFFICWAR_TIMEOUT = float(os.environ.get("TRAFFICWAR_TIMEOUT", "5"))
TRAFFICWAR_MAX_RETRIES = int(os.environ.get("TRAFFICWAR_MAX_RETRIES", "2"))
