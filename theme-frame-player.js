/* Package-bound RGBA review at the theme's exact frame order and FPS. */
window.ThemeFramePlayer = class ThemeFramePlayer {
  constructor(prefix, packageSha256, onFrame) {
    this.prefix=prefix; this.packageSha256=packageSha256; this.onFrame=onFrame;
    this.revision=0; this.frames=[]; this.trace=[]; this.elapsed=0; this.lastIndex=-1;
    this.element=document.createElement('div'); this.element.className='tilt-frame-playback';
    this.gallery=document.createElement('div'); this.gallery.className='tilt-playback-gallery';
    this.contexts=['#f4eee0','#b9d7ee','#252930'].map((color,i)=>{
      const panel=document.createElement('div'); panel.className=`tilt-raw-panel tilt-raw-panel-${i}`;
      const canvas=document.createElement('canvas'); canvas.width=190; canvas.height=254;
      canvas.setAttribute('aria-label',`待审原始动作，${['暖色','蓝色','深色'][i]}背景`);
      panel.append(canvas); this.gallery.append(panel); return {canvas,color,context:canvas.getContext('2d',{alpha:false})};
    });
    this.play=document.createElement('button'); this.play.type='button'; this.play.textContent='播放原始动作'; this.play.disabled=true;
    this.pauseButton=document.createElement('button'); this.pauseButton.type='button'; this.pauseButton.textContent='暂停原始动作'; this.pauseButton.disabled=true;
    this.status=document.createElement('p'); this.status.setAttribute('role','status');
    const buttons=document.createElement('div'); buttons.className='tilt-playback-buttons'; buttons.append(this.play,this.pauseButton);
    this.element.append(this.gallery,buttons,this.status);
    this.play.addEventListener('click',()=>this.start()); this.pauseButton.addEventListener('click',()=>this.pause());
    this.visibility=()=>{if(document.hidden)this.pause();}; document.addEventListener('visibilitychange',this.visibility);
    this.state('empty');
  }
  state(value) { this.element.dataset.playbackState=value; }
  pause() {
    if(this.element.dataset.playbackState==='playing') {
      this.elapsed=performance.now()-this.started; this.state('paused');
      this.status.textContent='已暂停原始动作；切换逐帧模式可放大检查。';
    }
    cancelAnimationFrame(this.raf); this.pauseButton.disabled=true;
    this.play.disabled=!this.frames.length;
  }
  reset() {
    this.pause(); this.revision++; this.controller?.abort();
    this.frames.forEach(f=>f?.image.close()); this.frames=[]; this.play.disabled=true;
    this.elapsed=0; this.lastIndex=-1; this.trace=[];this.fullReady=false;this.state('empty');
    this.contexts.forEach(({context,color})=>{context.fillStyle=color;context.fillRect(0,0,190,254);});
  }
  async prepare(slot,previewOnly=false) {
    this.reset(); const revision=this.revision; this.slot=slot; this.state('loading');
    this.status.textContent='正在准备原始动作…'; const controller=this.controller=new AbortController();
    const signal=controller.signal; const items=[];
    const timeout=setTimeout(()=>controller.abort(),60000);
    try {
      const metadataResponse=await fetch(`${this.prefix}playback.json?sha256=${this.packageSha256}`,{signal});
      if(!metadataResponse.ok)throw new Error('候选原始动作无法核验，请重新打开制作记录。');
      const metadata=await metadataResponse.json();
      const action=metadata.actions?.find(a=>a.slot===slot);
      if(metadata.packageSha256!==this.packageSha256 || metadata.approved!==false || !action ||
         !['idle','hover','click'].includes(slot) || !Number.isInteger(action.frameCount) || action.frameCount<1 || action.frameCount>120 ||
         !Number.isInteger(action.fps) || action.fps<1 || action.fps>30 || typeof action.loop!=='boolean')throw new Error('主题动作播放参数不匹配。');
      let next=0,done=0;
      const requestedCount=previewOnly?1:action.frameCount;
      await Promise.all(Array.from({length:Math.min(4,requestedCount)},async()=>{
        while(next<requestedCount) {
          const index=next++;
          const response=await fetch(`${this.prefix}frame/${slot}/${index}.png?sha256=${this.packageSha256}`,{signal});
          if(!response.ok)throw new Error('原始帧无法读取，未播放不完整动作。');
          const blob=await response.blob(), digest=response.headers.get('X-Frame-Sha256');
          const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
          if(blob.type!=='image/png' || actual!==digest)throw new Error('原始帧指纹不匹配。');
          const image=await createImageBitmap(blob);
          if(revision!==this.revision || signal.aborted) {image.close();throw new DOMException('Cancelled','AbortError');}
          if(image.width>768 || image.height>768) {image.close();throw new Error('原始帧尺寸不匹配。');}
          items[index]={image,sha256:digest}; done++;
          this.status.textContent=`正在准备完整原始动作 ${done}/${action.frameCount}…`;
        }
      }));
      if(revision!==this.revision) {items.forEach(f=>f?.image.close());return;}
      this.frames=items; this.action=action; this.fullReady=!previewOnly || action.frameCount===1;
      this.state('ready'); this.draw(0,0); this.trace=[];
      this.play.disabled=false;
      this.status.textContent=previewOnly?`原始首帧，点击播放完整 ${action.frameCount} 帧动作；尚未批准。`:`原始帧已准备，${action.fps} 帧/秒，${action.frameCount} 帧；尚未批准。`;
      this.element.dataset.fps=String(action.fps); this.element.dataset.frameCount=String(action.frameCount);
      this.element.dataset.loop=String(action.loop); this.element.dataset.packageSha256=this.packageSha256;
    } catch(error) {
      controller.abort(); items.forEach(f=>f?.image.close());
      if(revision===this.revision) {
        this.state('error'); this.play.disabled=true;
        this.status.textContent=error.name==='AbortError'?'原始动作准备已取消或超时，请重新选择显示方式。':error.message;
      }
    } finally {clearTimeout(timeout);}
  }
  draw(index,elapsed) {
    const frame=this.frames[index];
    this.contexts.forEach(({context,color})=>{
      context.fillStyle=color; context.fillRect(0,0,190,254);
      const scale=Math.min(190/frame.image.width,254/frame.image.height);
      const width=frame.image.width*scale,height=frame.image.height*scale;
      context.drawImage(frame.image,(190-width)/2,(254-height)/2,width,height);
    });
    this.lastIndex=index; this.element.dataset.frame=String(index); this.element.dataset.slot=this.slot;
    this.element.dataset.sha256=frame.sha256;
    this.trace.push({frame:index,elapsedMs:elapsed,sha256:frame.sha256});
    if(this.trace.length>512)this.trace.shift(); this.onFrame?.(index);
  }
  async start() {
    if(!this.frames.length || this.element.dataset.playbackState==='playing')return;
    if(!this.fullReady) {
      const preparing=this.prepare(this.slot),revision=this.revision;
      await preparing;
      if(revision===this.revision && this.fullReady && this.element.dataset.playbackState==='ready' && !document.hidden)this.start();
      return;
    }
    if(this.element.dataset.playbackState==='ended')this.elapsed=0;
    this.trace=[]; this.missed=0; this.element.dataset.missedFrames='0';
    this.started=performance.now()-this.elapsed; this.lastIndex=-1;
    this.lastStep=Math.floor(this.elapsed*this.action.fps/1000)-1; this.state('playing');
    this.play.disabled=true; this.pauseButton.disabled=false;
    this.status.textContent=`正在按 ${this.action.fps} 帧/秒播放原始动作；尚未批准。`;
    const tick=()=>{
      if(this.element.dataset.playbackState!=='playing')return;
      const elapsed=performance.now()-this.started, count=this.frames.length;
      const step=Math.floor(elapsed*this.action.fps/1000), index=this.action.loop?step%count:Math.min(step,count-1);
      if(index!==this.lastIndex) {
        const shownStep=this.action.loop?step:Math.min(step,count-1);
        if(shownStep>this.lastStep+1)this.missed+=shownStep-this.lastStep-1;
        this.draw(index,elapsed); this.element.dataset.missedFrames=String(this.missed);
        this.lastStep=shownStep;
      }
      if(!this.action.loop && step>=count) {
        this.state('ended'); this.elapsed=0; this.play.disabled=false; this.pauseButton.disabled=true;
        this.status.textContent=this.missed?'播放出现跳帧，请重新播放后再判断自然度。':'原始动作播放结束；尚未批准。'; return;
      }
      this.raf=requestAnimationFrame(tick);
    };
    tick();
  }
  dispose() {this.reset();document.removeEventListener('visibilitychange',this.visibility);}
};
