import os
import re
import sys
import tempfile
import aiohttp
import asyncio
from tqdm import tqdm
import subprocess
import argparse
import time

MAX_PARALLEL_DOWNLOADS = 4 # Максимальное кол-во параллельных загрузок сегментов

async def download_file(session, url, destination, progress_bar):
    async with session.get(url) as response:
        response.raise_for_status()
        total_size = int(response.headers.get('content-length', 0))
        with open(destination, 'wb') as file:
            downloaded = 0
            async for chunk in response.content.iter_chunked(64*1024):
                file.write(chunk)
                downloaded += len(chunk)
                progress_bar.update(len(chunk))

async def download_segment(session, ts_url, tmpdir, idx, overall_progress, semaphore, count_segments=False):
    async with semaphore:
        ts_file = os.path.join(tmpdir, f'{idx:05}.ts')
        retry_count = 3
        for _ in range(retry_count):
            try:
                async with session.get(ts_url) as response:
                    response.raise_for_status()
                    total_size = int(response.headers.get('content-length', 0))
                    with tqdm(total=total_size, desc=f"Сегмент {idx+1}", unit="B", unit_scale=True, leave=False) as pbar:
                        with open(ts_file, 'wb') as file:
                            async for chunk in response.content.iter_chunked(64*1024):
                                file.write(chunk)
                                pbar.update(len(chunk))
                                if not count_segments:
                                    overall_progress.update(len(chunk))
                if count_segments:
                    overall_progress.update(1)
                return ts_file
            except aiohttp.ClientError:
                if _ == retry_count - 1:
                    raise
                await asyncio.sleep(1)

async def get_total_size(session, urls):
    total_size = 0
    async with session.head(urls[0]) as response:
        size = int(response.headers.get('content-length', 0))
    if size == 0:
        return None
    for url in tqdm(urls, desc="Получение размеров файлов", unit="file"):
        async with session.head(url) as response:
            total_size += int(response.headers.get('content-length', 0))
    return total_size

def convert_to_mp4(result_file, max_retries=3):
    mp4_file = result_file + '.mp4'
    retry_count = 0
    
    while retry_count < max_retries:
        print(f"Попытка конвертации в MP4 ({retry_count + 1}/{max_retries})...")
        try:
            process = subprocess.Popen(
                ['ffmpeg', '-i', result_file, '-c', 'copy', mp4_file],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=False
            )
            
            while True:
                output = process.stderr.readline()
                if output == b'' and process.poll() is not None:
                    break
                if output:
                    try:
                        line = output.decode('utf-8').strip()
                    except UnicodeDecodeError:
                        line = output.decode('utf-8', errors='replace').strip()
                    if "Duration" in line or "time=" in line:
                        print(line)
            
            if process.returncode == 0:
                print(f"Конвертация завершена. Результат здесь:\n{mp4_file}")
                os.remove(result_file)
                print(f"Файл {result_file} удалён.")
                return True
            else:
                error_output = process.stderr.read()
                try:
                    error_output = error_output.decode('utf-8')
                except UnicodeDecodeError:
                    error_output = error_output.decode('utf-8', errors='replace')
                print(f"Ошибка при конвертации файла: {error_output}")
                
                if os.path.exists(mp4_file):
                    os.remove(mp4_file)
                    print(f"Неполный файл {mp4_file} удалён.")
                
                retry_count += 1
                if retry_count < max_retries:
                    print(f"Повторная попытка через 5 секунд...")
                    time.sleep(5)
                else:
                    print("Достигнуто максимальное количество попыток. Конвертация не удалась.")
                    return False
        
        except Exception as e:
            print(f"Произошла ошибка: {str(e)}")
            if os.path.exists(mp4_file):
                os.remove(mp4_file)
                print(f"Неполный файл {mp4_file} удалён.")
            
            retry_count += 1
            if retry_count < max_retries:
                print(f"Повторная попытка через 5 секунд...")
                time.sleep(5)
            else:
                print("Достигнуто максимальное количество попыток. Конвертация не удалась.")
                return False

    return False

async def main(url, result_file, no_pre_download):
    async with aiohttp.ClientSession() as session:
        with tempfile.TemporaryDirectory() as tmpdir:
            main_playlist = os.path.join(tmpdir, 'main_playlist.m3u8')
            
            print("Загрузка основного плейлиста...")
            with tqdm(total=None, desc="Основной плейлист", unit="B", unit_scale=True) as pbar:
                await download_file(session, url, main_playlist, pbar)
            
            with open(main_playlist, 'r', encoding='utf-8') as f:
                main_playlist_content = f.read()

            ts_or_bin_pattern = re.compile(r'^https?://.*\.(ts|bin)', re.MULTILINE)
            second_playlist = os.path.join(tmpdir, 'second_playlist.m3u8')

            if ts_or_bin_pattern.search(main_playlist_content):
                with open(second_playlist, 'w', encoding='utf-8') as f:
                    f.write(main_playlist_content)
            else:
                tail = main_playlist_content.strip().split('\n')[-1]
                if not re.match(r'^https?://', tail):
                    print("В содержимом заданной ссылки нет прямых ссылок на файлы *.bin (*.ts) (первый вариант),")
                    print("также последняя строка в ней не содержит ссылки на другой плей-лист (второй вариант).")
                    print("Либо указана неправильная ссылка, либо GetCourse изменил алгоритмы.")
                    print("Если уверены, что дело в изменившихся алгоритмах GetCourse, опишите проблему здесь:")
                    print("https://github.com/mikhailnov/getcourse-video-downloader/issues (на русском).")
                    print("Если уверены, что это ошибка скрипта, то опишите проблему здесь:")
                    print("https://github.com/snhplayer/GetCoursePythonDownloader/issues")
                    return
                
                print("Загрузка вторичного плейлиста...")
                with tqdm(total=None, desc="Вторичный плейлист", unit="B", unit_scale=True) as pbar:
                    await download_file(session, tail, second_playlist, pbar)

            with open(second_playlist, 'r', encoding='utf-8') as f:
                lines = f.readlines()
                ts_urls = [line.strip() for line in lines if re.match(r'^https?://', line.strip())]
            
            print(f"Число сегментов для загрузки: {len(ts_urls)}")
            
            total_size = None
            if not no_pre_download:
                total_size = await get_total_size(session, ts_urls)

            semaphore = asyncio.Semaphore(MAX_PARALLEL_DOWNLOADS)
            
            if no_pre_download:
                overall_pbar = tqdm(total=len(ts_urls), desc="Общий прогресс", unit="сегмент")
            else:
                overall_pbar = tqdm(total=total_size, desc="Общий прогресс", unit="B", unit_scale=True)

            tasks = [download_segment(session, ts_url, tmpdir, idx, overall_pbar, semaphore, count_segments=no_pre_download) 
                     for idx, ts_url in enumerate(ts_urls)]
            ts_files = []
            for task in asyncio.as_completed(tasks):
                ts_file = await task
                ts_files.append(ts_file)

            overall_pbar.close()

            print("Объединение сегментов...")
            with open(result_file, 'wb') as result:
                for ts_file in tqdm(sorted(ts_files), desc="Объединение", unit="file"):
                    with open(ts_file, 'rb') as ts:
                        result.write(ts.read())

            print(f"Скачивание завершено. Результат здесь:\n{result_file}")
            
            if convert_to_mp4(result_file):
                print("Конвертация успешно завершена.")
            else:
                print("Не удалось выполнить конвертацию после нескольких попыток.")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Download and process video segments.')
    parser.add_argument('-npd', '--no-pre-download', action='store_true', help='Пропустить предварительную загрузку размеров')
    args = parser.parse_args()

    while True:
        url = input("Введите ссылку на плей-лист: ")
        result_file = input("Введите имя выходного файла: ")
        asyncio.run(main(url, result_file, args.no_pre_download))