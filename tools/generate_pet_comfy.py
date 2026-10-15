"""Local photo + Prompt generator for the native AI-PET generation protocol.

Starts its own isolated ComfyUI process, uses Wan 2.2 for motion and BiRefNet
for alpha. Two/three reference photos use Qwen Image Edit to form the anchor.
Outputs a review-required theme, never an installed or approved pet.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen
import uuid

from PIL import Image, ImageOps

ROOT = Path(__file__).absolute().parents[1]
FRAME_WIDTH, FRAME_HEIGHT = 768, 768
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
# Official Comfy-Org/Wan_2.2_ComfyUI_Repackaged LFS sizes and SHA-256.
WAN_MODELS = {
    'wan2.2_ti2v_5B_fp16.safetensors': (9999658848, '456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e'),
    'umt5_xxl_fp8_e4m3fn_scaled.safetensors': (6735906897, 'c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68'),
    'wan2.2_vae.safetensors': (1409400960, 'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156'),
}


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, path)


def progress(path: Path, message: str, **extra) -> None:
    atomic_json(path, dict(message=message, **extra))


def request_json(url: str, value=None):
    body = None if value is None else json.dumps(value).encode()
    with urlopen(Request(url, data=body, headers={'Content-Type': 'application/json'}), timeout=15) as response:
        return json.load(response)


def segment_batch(spec: Path, progress_path: Path) -> None:
    from run_birefnet import load_birefnet, segment_photo
    jobs = json.loads(spec.read_text(encoding='utf-8'))
    runtime = load_birefnet(Path(jobs['model']), 'cuda', spec.parent / 'hf-cache')
    for index, pair in enumerate(jobs['images']):
        progress(progress_path, f"正在处理透明背景 {index + 1}/{len(jobs['images'])}…")
        with Image.open(pair[0]) as source:
            _, rgba, _ = segment_photo(ImageOps.exif_transpose(source).convert('RGB'), runtime, 1024)
        rgba.save(pair[1])


def segment(images: list[tuple[Path, Path]], model: Path, work: Path, progress_path: Path) -> None:
    spec = work / ('segment-' + uuid.uuid4().hex + '.json')
    atomic_json(spec, {'model': str(model), 'images': [[str(a), str(b)] for a, b in images]})
    result = subprocess.run([sys.executable, str(Path(__file__).absolute()), '--segment', str(spec), '--progress', str(progress_path)], creationflags=NO_WINDOW)
    if result.returncode:
        detail = json.loads(progress_path.read_text(encoding='utf-8')).get('error', '透明背景处理失败，请让 Agent 检查本地模型。')
        raise RuntimeError(detail)


def run_graph(server: str, graph: dict, work: Path, label: str, process: subprocess.Popen) -> list[dict]:
    queued = request_json(server + '/prompt', {'prompt': graph, 'client_id': uuid.uuid4().hex})
    prompt_id = queued.get('prompt_id')
    if not isinstance(prompt_id, str):
        raise RuntimeError('模型拒绝生成请求，详情保存在本次生成记录。')
    # A live server job is identified before observation; never resubmit after a polling timeout.
    atomic_json(work / (label + '-job.json'), {'promptId': prompt_id, 'server': server, 'status': 'submitted', 'graph': graph})
    while True:
        try:
            history = request_json(server + '/history/' + prompt_id).get(prompt_id)
        except OSError:
            if process.poll() is not None:
                raise RuntimeError('本地模型进程已结束，可以让 Agent 检查本次生成记录。')
            time.sleep(2); continue
        if history:
            atomic_json(work / (label + '-history.json'), history)
            if history.get('status', {}).get('status_str') == 'error':
                raise RuntimeError('模型生成失败，详情保存在本次生成记录。')
            images = [image for node in history.get('outputs', {}).values() for image in node.get('images', [])]
            if not images:
                raise RuntimeError('模型没有输出图像。')
            return images
        time.sleep(2)


def model_file(directory: Path, name: str) -> Path:
    matches = list(directory.rglob(name))
    if len(matches) != 1:
        raise ValueError('缺少或重复的本地模型：' + name)
    return matches[0]


def result_paths(images: list[dict], directory: Path) -> list[Path]:
    paths = []
    for image in images:
        if image.get('type') != 'output':
            raise ValueError('模型输出类型无效。')
        path = (directory / image.get('subfolder', '') / image['filename']).resolve(strict=True)
        if directory.resolve() not in path.parents:
            raise ValueError('模型输出路径无效。')
        paths.append(path)
    return paths


def qwen_anchor(names: list[str], seed: int, prompt: str) -> dict:
    images = {'image' + str(index + 1): [str(20 + index), 0] for index in range(len(names))}
    graph = {
        '1': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'qwen_image_vae.safetensors'}},
        '2': {'class_type': 'UnetLoaderGGUF', 'inputs': {'unet_name': 'qwen-image-edit-2509-Q4_K_M.gguf'}},
        '3': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'type': 'qwen_image', 'device': 'default'}},
        '4': {'class_type': 'TextEncodeQwenImageEditPlus', 'inputs': dict(clip=['3', 0], vae=['1', 0], prompt=
              'Use all reference images to create one pet matching the user request. User request: ' + prompt +
              ' Final starting-frame constraints: preserve the pose, camera angle and identity of image 1 unless the user '
              'explicitly changes the character design or style. Use the other images for consistent visual details. '
              'For an animated motion request, show the pose BEFORE the movement, never the final action pose; the movement '
              'will be generated in a separate video step. Show one anatomically correct pet on plain white, with the '
              'entire body, paws and tail inside the image. No duplicate animals, no contact sheets.', **images)},
        '5': {'class_type': 'TextEncodeQwenImageEditPlus', 'inputs': dict(clip=['3', 0], vae=['1', 0], prompt='', **images)},
        '6': {'class_type': 'ModelSamplingAuraFlow', 'inputs': {'model': ['2', 0], 'shift': 3.1}},
        '7': {'class_type': 'EmptySD3LatentImage', 'inputs': {'width': 768, 'height': 768, 'batch_size': 1}},
        '8': {'class_type': 'KSampler', 'inputs': {'model': ['6', 0], 'positive': ['4', 0], 'negative': ['5', 0],
              'latent_image': ['7', 0], 'seed': seed, 'steps': 20, 'cfg': 4.0, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1.0}},
        '9': {'class_type': 'VAEDecode', 'inputs': {'samples': ['8', 0], 'vae': ['1', 0]}},
        '10': {'class_type': 'SaveImage', 'inputs': {'images': ['9', 0], 'filename_prefix': 'anchor'}}
    }
    for index, name in enumerate(names):
        graph[str(20 + index)] = {'class_type': 'LoadImage', 'inputs': {'image': name}}
    return graph


def wan_motion(seed: int, frames: int, steps: int, prompt: str) -> dict:
    # ComfyUI's Wan 2.2 TI2V-5B image-to-video nodes; no species/action template.
    return {
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'wan2.2_ti2v_5B_fp16.safetensors', 'weight_dtype': 'default'}},
        '2': {'class_type': 'ModelSamplingSD3', 'inputs': {'model': ['1', 0], 'shift': 8.0}},
        '3': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'type': 'wan', 'device': 'default'}},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['3', 0], 'text': prompt}},
        '5': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['3', 0], 'text': 'extra animals, people, human hands, human arms, extra limbs, missing limbs, duplicate tail, changed identity, camera movement, zoom, text, watermark, furniture'}},
        '6': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'wan2.2_vae.safetensors'}},
        '7': {'class_type': 'LoadImage', 'inputs': {'image': 'pet.png'}},
        '8': {'class_type': 'Wan22ImageToVideoLatent', 'inputs': {'width': FRAME_WIDTH, 'height': FRAME_HEIGHT, 'length': frames, 'batch_size': 1, 'vae': ['6', 0], 'start_image': ['7', 0]}},
        '9': {'class_type': 'KSampler', 'inputs': {'model': ['2', 0], 'positive': ['4', 0], 'negative': ['5', 0], 'latent_image': ['8', 0],
              'seed': seed, 'steps': steps, 'cfg': 5.0, 'sampler_name': 'uni_pc', 'scheduler': 'simple', 'denoise': 1.0}},
        '10': {'class_type': 'VAEDecode', 'inputs': {'samples': ['9', 0], 'vae': ['6', 0]}},
        '11': {'class_type': 'SaveImage', 'inputs': {'images': ['10', 0], 'filename_prefix': 'motion'}}
    }


def generate(request_path: Path, output: Path, config_path: Path, progress_path: Path) -> None:
    from theme_package import pack_multi
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    request = json.loads(request_path.read_text(encoding='utf-8-sig'))
    if output.exists() or request.get('version') != 1 or not isinstance(request.get('prompt'), str) or not request['prompt'].strip():
        raise ValueError('创作请求无效或输出已存在。')
    references = request.get('references')
    if not isinstance(references, list) or not 1 <= len(references) <= 3:
        raise ValueError('这个本地生成器支持 1–3 张参考图片。')
    photos = []
    for reference in references:
        photo = request_path.parent / reference['path']
        if Path(reference['path']).name != reference['path'] or photo.is_symlink() or not photo.is_file() or photo.stat().st_size > 10 * 1024 * 1024:
            raise ValueError('参考图片路径无效。')
        if hashlib.sha256(photo.read_bytes()).hexdigest() != reference['sha256']:
            raise ValueError('参考图片已变化，请重新保存请求。')
        photos.append(photo)
    work = output.parent; work.mkdir(parents=True, exist_ok=True)
    model_dir = Path(config['wanModelDirectory']); matte = Path(config['mattingModelDirectory'])
    comfy = Path(config['comfyDirectory']); python = Path(config['comfyPython'])
    if not (comfy / 'main.py').is_file() or not python.is_file():
        raise ValueError('请让 Agent 配置本机 ComfyUI。')
    progress(progress_path, '正在准备本地模型和参考图片…')
    # Pinned model hashes are checked on use; no weights or code are downloaded here.
    for name, (size, digest) in WAN_MODELS.items():
        model = model_dir / name
        if not model.is_file() or model.stat().st_size != size:
            raise ValueError('本地 Wan 模型不完整：' + model.name)
        sha = hashlib.sha256()
        with model.open('rb') as stream:
            for block in iter(lambda: stream.read(8 * 1024 * 1024), b''): sha.update(block)
        if sha.hexdigest() != digest:
            raise ValueError('本地 Wan 模型校验失败：' + model.name)
    server_root = work / 'server'
    input_dir = server_root / 'input'; output_dir = server_root / 'output'
    for directory in (input_dir, output_dir, server_root / 'user', server_root / 'temp', server_root / 'custom_nodes'): directory.mkdir(parents=True)
    names = []
    for index, photo in enumerate(photos):
        name = 'reference-' + str(index + 1) + '.png'; names.append(name)
        with Image.open(photo) as source: ImageOps.exif_transpose(source).convert('RGB').save(input_dir / name)
    anchor = work / 'anchor.png'
    if len(photos) == 1:
        segment([(photos[0], anchor)], matte, work, progress_path)
    mapping = {'diffusion_models': str(model_dir), 'text_encoders': str(model_dir), 'vae': str(model_dir)}
    if len(photos) > 1:
        qwen = Path(config['qwenModelDirectory'])
        mapping['diffusion_models'] += '\n' + str(model_file(qwen, 'qwen-image-edit-2509-Q4_K_M.gguf').parent)
        mapping['unet'] = str(model_file(qwen, 'qwen-image-edit-2509-Q4_K_M.gguf').parent)
        mapping['text_encoders'] += '\n' + str(model_file(qwen, 'qwen_2.5_vl_7b_fp8_scaled.safetensors').parent)
        mapping['vae'] += '\n' + str(model_file(qwen, 'qwen_image_vae.safetensors').parent)
        mapping['custom_nodes'] = str(comfy / 'custom_nodes')
    paths_config = work / 'model-paths.yaml'; atomic_json(paths_config, {'ai_pet': mapping})
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0)); port = reservation.getsockname()[1]
    server = 'http://127.0.0.1:' + str(port)
    arguments = [str(python), str(comfy / 'main.py'), '--listen', '127.0.0.1', '--port', str(port),
                 '--base-directory', str(server_root), '--user-directory', str(server_root / 'user'),
                 '--extra-model-paths-config', str(paths_config), '--disable-auto-launch', '--disable-all-custom-nodes']
    if len(photos) > 1: arguments += ['--whitelist-custom-nodes', 'ComfyUI-GGUF']
    progress(progress_path, '正在启动本地动画模型…')
    with (work / 'server.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen(arguments, cwd=comfy, stdout=log, stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
        atomic_json(work / 'server-process.json', {'pid': process.pid, 'server': server, 'owned': True})
        try:
            deadline = time.monotonic() + 180
            while True:
                if process.poll() is not None: raise RuntimeError('本地模型启动失败，请让 Agent 检查 server.log。')
                try:
                    request_json(server + '/system_stats'); break
                except OSError:
                    if time.monotonic() > deadline: raise TimeoutError('本地模型启动超时。')
                    time.sleep(1)
            seed = secrets.randbelow(2**63)
            if len(photos) > 1:
                progress(progress_path, '正在结合多张参考图制作宠物形象…')
                images = run_graph(server, qwen_anchor(names, seed, request['prompt']), work, 'anchor', process)
                with Image.open(result_paths(images, output_dir)[0]) as image: image.convert('RGBA').save(anchor)
            with Image.open(anchor) as image:
                bounds = image.getchannel('A').getbbox()
                if bounds is None: raise ValueError('未能从照片识别宠物，请换一张清晰照片。')
                pet = ImageOps.contain(image.crop(bounds), (512, 384), Image.Resampling.LANCZOS)
                canvas = Image.new('RGBA', (FRAME_WIDTH, FRAME_HEIGHT), 'white')
                canvas.alpha_composite(pet, ((FRAME_WIDTH - pet.width)//2, (FRAME_HEIGHT - pet.height)//2))
                canvas.convert('RGB').save(input_dir / 'pet.png')
            positive = ('One pet, same identity and markings as the reference image. Plain white seamless background, '
                        'locked camera, entire animal inside frame with margin. Perform the requested action naturally, '
                        'then return to the starting pose. User request: ' + request['prompt'])
            progress(progress_path, '正在按你的描述生成动作，可能需要几分钟…')
            frames, steps = int(config.get('frames', 49)), int(config.get('steps', 24))
            if not 9 <= frames <= 81 or (frames - 1) % 4 or not 10 <= steps <= 40: raise ValueError('动画模型参数无效。')
            images = run_graph(server, wan_motion(seed, frames, steps, positive), work, 'motion', process)
            source_frames = result_paths(images, output_dir)
        finally:
            if process.poll() is None: process.terminate()
            process.wait(timeout=20)
    if not 2 <= len(source_frames) <= 120: raise ValueError('动画帧数无效。')
    rgba_dir = work / 'rgba'; rgba_dir.mkdir()
    rgba_paths = [rgba_dir / (f'{index:04d}.png') for index in range(len(source_frames))]
    segment(list(zip(source_frames, rgba_paths)), matte, work, progress_path)
    progress(progress_path, '正在整理动作预览…')
    bounds = None
    for path in rgba_paths:
        with Image.open(path) as image:
            solid = image.getchannel('A').point(lambda alpha: 255 if alpha > 32 else 0).getbbox()
            if solid is None or solid[0] <= 1 or solid[1] <= 1 or solid[2] >= image.width - 1 or solid[3] >= image.height - 1:
                raise ValueError('生成的动作超出了画面或缺少主体，请重试或缩小动作幅度。')
            box = image.getchannel('A').getbbox()
            if box is None: raise ValueError('生成的动作中有空白帧，请重试。')
            bounds = box if bounds is None else (min(bounds[0], box[0]), min(bounds[1], box[1]), max(bounds[2], box[2]), max(bounds[3], box[3]))
    animation = work / 'action'; animation.mkdir()
    idle = work / 'idle'; idle.mkdir()
    for index, path in enumerate(rgba_paths):
        with Image.open(path) as image:
            fitted = ImageOps.contain(image.crop(bounds), (360, 488), Image.Resampling.LANCZOS)
            canvas = Image.new('RGBA', (384, 512))
            canvas.alpha_composite(fitted, ((384 - fitted.width)//2, (512 - fitted.height)//2))
            canvas.save(animation / f'frame-{index:03d}.png')
            if index == 0: canvas.save(idle / 'frame-000.png')
    spec = work / 'theme-spec.json'
    atomic_json(spec, {'name': request['prompt'].strip()[:48], 'actions': [
        {'slot': 'idle', 'fps': 1, 'loop': True, 'directory': 'idle'},
        {'slot': 'click', 'fps': 24, 'loop': False, 'directory': 'action'},
        {'slot': 'recent-activity', 'fps': 24, 'loop': True, 'directory': 'action'}]})
    pack_multi(argparse.Namespace(spec=spec, output=output))
    atomic_json(work / 'generation-provenance.json', {'requestSha256': hashlib.sha256(request_path.read_bytes()).hexdigest(),
                'referenceCountUsed': len(photos), 'provider': 'local-comfy-wan22-birefnet', 'seed': seed,
                'prompt': request['prompt'], 'frameCount': len(source_frames), 'review': 'required', 'installed': False})
    progress(progress_path, '动作已生成，等待你预览。')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path); parser.add_argument('--output', type=Path)
    parser.add_argument('--config', type=Path); parser.add_argument('--progress', type=Path, required=True)
    parser.add_argument('--segment', type=Path)
    args = parser.parse_args()
    try:
        if args.segment: segment_batch(args.segment, args.progress)
        else:
            if not all((args.request, args.output, args.config)): parser.error('request, output and config required')
            generate(args.request.absolute(), args.output.absolute(), args.config.absolute(), args.progress.absolute())
    except Exception as error:
        progress(args.progress, str(error)[:200], error=str(error)[:200])
        raise


if __name__ == '__main__': main()
