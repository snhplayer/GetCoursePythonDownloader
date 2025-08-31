# GetCoursePythonDownloader

Этот скрипт предназначен для загрузки видео с платформы GetCourse и основан на [этом скрипте](https://github.com/mikhailnov/getcourse-video-downloader). Он загружает сегменты видео, объединяет их и конвертирует в формат MP4.

## Особенности

- Асинхронная загрузка сегментов видео
- Прогресс-бары для отслеживания загрузки
- Автоматическое объединение сегментов
- Конвертация в MP4 с использованием FFmpeg
- Поддержка повторных попыток при ошибках загрузки и конвертации

## Требования

- Python 3.7+
- FFmpeg
- Библиотеки Python: aiohttp, tqdm

## Установка

1. Клонируйте репозиторий:
   ```
   git clone https://github.com/snhplayer/GetCoursePythonDownloader.git
   cd GetCoursePythonDownloader
   ```

2. Установите необходимые библиотеки:
   ```
   pip install aiohttp tqdm
   ```

3. Убедитесь, что FFmpeg установлен и доступен в системном PATH или находится в одной папке со скриптом.

## Установка FFmpeg

Скрипту нужен установленный FFmpeg (должен быть доступен в `PATH` или лежать рядом с `gcpd.py`). Проверить установку можно командой `ffmpeg -version`.

### Windows

Самый простой путь — через пакетный менеджер **winget** (Windows 10/11):

```powershell
winget install --id Gyan.FFmpeg -e
```

Альтернативы:

* **Chocolatey**:

  ```powershell
  choco install ffmpeg
  ```
* **Scoop**:

  ```powershell
  scoop install ffmpeg
  ```
* Ручная установка (zip-архив): скачайте сборку FFmpeg для Windows со страницы загрузок FFmpeg (раздел *Windows builds*), распакуйте и добавьте папку `bin` в переменную окружения `PATH`.

Примечание: `winget` пакет **Gyan.FFmpeg** ставит официально рекомендуемую сборку; подробнее см. карточку пакета.
Chocolatey и Scoop также предоставляют готовые бинарники.

### Linux

#### Ubuntu / Debian

```bash
sudo apt update
sudo apt install ffmpeg
ffmpeg -version
```

FFmpeg доступен в официальных репозиториях Ubuntu/Debian (подробности на Launchpad/Debian Packages).

> Альтернатива: Snap-пакет `ffmpeg` (удобно, но может отличаться по набору кодеков и изоляции):
> `sudo snap install ffmpeg` 

#### Fedora

На Fedora «полная» сборка FFmpeg ставится из репозиториев **RPM Fusion**:

1) Подключить RPM Fusion (Free и Nonfree)
```bash
sudo dnf install \
  https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm \
  https://download1.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-$(rpm -E %fedora).noarch.rpm
```
2) Установить FFmpeg
```bash
sudo dnf install ffmpeg

ffmpeg -version
```

Подробные инструкции по включению RPM Fusion есть в документации Fedora и на сайте RPM Fusion. Учтите, что в официальном репозитории Fedora есть урезанный пакет `ffmpeg-free`; для максимальной совместимости обычно используют пакет `ffmpeg` из RPM Fusion.

#### Arch Linux

```bash
sudo pacman -S ffmpeg
ffmpeg -version
```

Пакет доступен в официальном репозитории (`extra`), см. Arch Wiki и карточку пакета.

### macOS

Рекомендуемый способ — **Homebrew**:

```bash
# если brew ещё не установлен: https://brew.sh
brew install ffmpeg
ffmpeg -version
```

Страница формулы Homebrew подтверждает доступность для Apple Silicon и Intel.

Альтернативы:

* **MacPorts**:

  ```bash
  sudo port install ffmpeg
  ```

* Статические сборки для macOS доступны со страницы загрузок FFmpeg (раздел *macOS*).

---

### Проверка установки

После установки выполните:

```bash
ffmpeg -version
ffprobe -version
```

Если команды не находятся, убедитесь, что путь к каталогу с бинарниками (`ffmpeg`, `ffprobe`) добавлен в `PATH`. Ссылки на официальные способы получения готовых сборок (Windows/macOS/Linux) приведены на странице загрузок FFmpeg.

## Использование

Запустите скрипт:

```
python gcpd.py
```

Следуйте инструкциям в командной строке:

1. Введите ссылку на плейлист.
2. Укажите имя выходного файла.

Дополнительные опции:

- `--pd`: Включить предварительную загрузку размеров файлов (по умолчанию отключена).

Пример:
```
python gcpd.py --pd {url}
```

-  Возможность определить количество параллельных потоков

Пример:
Меняя
```
MAX_PARALLEL_DOWNLOADS = 4 
```
на
```
MAX_PARALLEL_DOWNLOADS = 5
```
Мы, соотвественно, меняем количество параллельных потоков закгрузки с 4 на 5.
 
 - `-f`: Указать файл где находятся ссылки плей-листов и имена выходных файлов

Пример:
```
python gcpd.py -f a.txt
```
a.txt
```
https://....
foo
https://....
foo2
https://....
foo3
```

## Решение проблем

Если возникают проблемы с загрузкой или конвертацией, скрипт автоматически попытается повторить операцию. Если проблема сохраняется, проверьте:

1. Правильность ссылки на плейлист.
2. Наличие доступа к интернету.
3. Корректность установки FFmpeg.
4. Свободное место на диске.

## Вклад в проект

Если вы обнаружили ошибку или у вас есть предложения по улучшению, пожалуйста, создайте issue или pull request в репозитории проекта.

