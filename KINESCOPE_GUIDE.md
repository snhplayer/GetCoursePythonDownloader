# Руководство по работе с Kinescope

## Что это?

Kinescope использует отдельные дорожки для видео и аудио. Скрипт автоматически скачивает обе дорожки и объединяет их в один MP4 файл.

## Формат ссылок Kinescope

```
https://kinescope.io/VIDEO_ID/media.m3u8?quality=720&type=video
https://kinescope.io/VIDEO_ID/media.m3u8?quality=720&type=audio&lang=und
```

### Как получить ссылки:
1. Откройте видео в браузере
2. Нажмите F12 (открыть DevTools)
3. Перейдите на вкладку Network
4. Начните воспроизведение видео
5. Найдите запросы к `media.m3u8?quality=720&type=video` и `type=audio`
6. Скопируйте полные URL (ПКМ → Copy → Copy URL)

## Способы использования

### 1. Через файл (рекомендуется)

Создайте текстовый файл (например, `kinescope.txt`) в формате:

```
https://kinescope.io/VIDEO_ID/media.m3u8?quality=720&type=video
https://kinescope.io/VIDEO_ID/media.m3u8?quality=720&type=audio&lang=und
output_video_name
```

Запустите:
```bash
python gcpd.py -f kinescope.txt
```

### 2. Интерактивный режим

```bash
python gcpd.py
```

Скрипт автоматически определит Kinescope ссылку и попросит ввести:
1. Ссылку на видео дорожку
2. Ссылку на аудио дорожку
3. Имя выходного файла

## Смешанный режим (m3u8 + Kinescope)

Можно комбинировать в одном файле:

```
https://playlist.servicecdn.ru/.../playlist.m3u8
video1_name
https://kinescope.io/VIDEO_ID/media.m3u8?quality=720&type=video
https://kinescope.io/VIDEO_ID/media.m3u8?quality=720&type=audio&lang=und
video2_name
https://playlist.servicecdn.ru/.../playlist2.m3u8
video3_name
```

Скрипт автоматически определит тип каждой ссылки и обработает соответствующим образом.

## Требования

- FFmpeg должен быть установлен и доступен в PATH
- yt-dlp должен быть установлен (`pip install yt-dlp`)
- Библиотеки: aiohttp, tqdm

## Примечания

- Расширение `.mp4` добавляется автоматически, если не указано
- Скачивание происходит с прогресс-барами для каждой дорожки
- Объединение выполняется без перекодирования (быстро)
- Временные файлы автоматически удаляются после объединения
- Используется yt-dlp для надёжного скачивания HLS потоков
