# Деплой Opsbot

Схема деплоя:

1. Код лежит в GitHub.
2. На сервере установлен Docker и Docker Compose.
3. В GitHub Actions добавлены SSH-секреты.
4. При пуше в `main` workflow собирает архив, отправляет его на сервер и делает `docker compose up -d --build`.

## Подготовка сервера

На сервере один раз:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo mkdir -p /opt/opsbot/app/data
sudo chown -R "$USER":"$USER" /opt/opsbot
```

Создайте файл `/opt/opsbot/app/.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:replace_me
ADMIN_TELEGRAM_IDS=123456789,987654321
CHECK_INTERVAL_MINUTES=60
DATA_FILE=/data/opsbot.json
```

Если локально уже есть `data/opsbot.json`, перенесите его на сервер в:

```text
/opt/opsbot/app/data/opsbot.json
```

## GitHub Secrets

В репозитории откройте:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

Добавьте:

```text
SSH_HOST       IP или домен сервера
SSH_USER       пользователь на сервере
SSH_PRIVATE_KEY приватный SSH-ключ для деплоя
DEPLOY_PATH    /opt/opsbot
```

Публичную часть SSH-ключа нужно добавить в `~/.ssh/authorized_keys` пользователя на сервере.

## Проверка на сервере

```bash
cd /opt/opsbot/app
docker compose ps
docker compose logs -f opsbot
```
