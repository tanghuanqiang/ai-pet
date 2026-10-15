"""Encode browser review directly from fingerprinted lossless RGB composites."""
import json,re,subprocess
from pathlib import Path
from PIL import Image,ImageDraw
from transparent_head_tilt import sha
from review_all_rgba_frames import render_panel,BACKGROUNDS

def encode_review_assets(motion,actions,encoder):
    motion=Path(motion);encoder=Path(encoder).resolve()
    # Validate the complete input before creating a review output directory.
    if not encoder.is_file():raise ValueError('Review FFmpeg unavailable')
    inputs=[]
    for slot,action in actions.items():
        fps=action['fps'];frames=action['frames']
        if slot not in ('idle','hover','click') or type(fps) is not int or not 1<=fps<=60 or not 1<=len(frames)<=120:
            raise ValueError('Invalid review action')
        if (motion/(slot+'-190px.mp4')).exists():raise ValueError('Refusing to overwrite review video')
        for frame in frames:
            name=frame['file']
            if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.png',name):raise ValueError('Invalid review frame name')
            path=motion/slot/name
            if sha(path)!=frame['sha256']:raise ValueError('Review frame fingerprint mismatch')
            with Image.open(path) as im:
                if im.mode!='RGBA':raise ValueError('Expected RGBA review frame')
        inputs.append((slot,action))
    if not inputs:raise ValueError('No review actions')
    root=motion/'review-frames';root.mkdir(exist_ok=False);phases=[];records={}
    for slot,action in inputs:
        folder=root/slot;folder.mkdir();frames=[]
        for index,frame in enumerate(action['frames']):
            with Image.open(motion/slot/frame['file']) as im:
                strip=Image.new('RGB',(570,254))
                for col,(_,color) in enumerate(BACKGROUNDS):strip.paste(render_panel(im,color),(190*col,0))
            path=folder/f'frame-{index:03d}.png';strip.save(path)
            frames.append({'file':str(path.relative_to(motion)).replace('\\','/'),'sha256':sha(path),'sourceSha256':frame['sha256']})
            peak=9 if slot=='hover' and len(action['frames'])==60 else (16 if slot=='click' else len(action['frames'])//2)
            if index in (0,peak,len(action['frames'])-1):phases.append((slot,index,strip))
        video=motion/(slot+'-190px.mp4')
        command=[str(encoder),'-nostdin','-v','error','-framerate',str(action['fps']),'-start_number','0',
            '-i',str(folder/'frame-%03d.png'),'-frames:v',str(len(frames)),'-c:v','libx264','-preset','medium',
            '-crf','10','-pix_fmt','yuv420p','-movflags','+faststart',str(video)]
        log=motion/(slot+'-video-encode.log')
        (motion/(slot+'-video-command.json')).write_text(json.dumps(command,indent=2),encoding='utf-8')
        try:
            result=subprocess.run(command,capture_output=True,timeout=60)
        except subprocess.TimeoutExpired as error:
            log.write_bytes(error.stderr or b'');raise ValueError('Review video encoding timed out') from error
        log.write_bytes(result.stderr)
        if result.returncode:raise ValueError('Direct PNG review video encoding failed')
        records[slot]={'fps':action['fps'],'frameCount':len(frames),'frames':frames,'videoSha256':sha(video),
            'commandSha256':sha(motion/(slot+'-video-command.json')),'logSha256':sha(log)}
    sheet=Image.new('RGB',(570,279*len(phases)),'white');draw=ImageDraw.Draw(sheet)
    for row,(slot,index,strip) in enumerate(phases):
        draw.text((5,row*279+5),f'{slot} frame {index} UNAPPROVED',fill='black');sheet.paste(strip,(0,row*279+25))
    sheet.save(motion/'phases.png')
    report={'approved':False,'route':'lossless-png-to-h264-review-v1','intermediateLossyVideo':False,
        'encoderSha256':sha(encoder),'scriptSha256':sha(Path(__file__)),'codec':'libx264','crf':10,'pixelFormat':'yuv420p',
        'lossyFinalVideo':True,'actions':records,'phasesSha256':sha(motion/'phases.png'),
        'limitations':['Browser H.264 retains chroma subsampling and compression','Use original RGBA for fine-edge review','No motion or installation approval']}
    (motion/'review-encoding.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    return {'route':report['route'],'reportSha256':sha(motion/'review-encoding.json'),'intermediateLossyVideo':False,
            'lossyFinalVideo':True,'codec':'libx264','crf':10,'pixelFormat':'yuv420p'}
