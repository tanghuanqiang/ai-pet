(() => {
  const status = document.createElement('aside');
  status.className = 'photo-framing-note';
  status.setAttribute('aria-label', '本机创作程序');
  const text = document.createElement('p');
  text.textContent = '本机工坊：歪头制作、毛边细化可离线使用。AI 文字解释需已登录的 Codex CLI；分割、眨眼和视频模型仍需单独配置。';
  const stop = document.createElement('button');
  stop.className = 'secondary-button'; stop.type = 'button'; stop.textContent = '关闭本机工坊';
  status.append(text, stop);
  const settings = document.createElement('details');
  settings.className = 'simple-disclosure';
  const summary = document.createElement('summary'); summary.textContent = '创作空间设置';
  settings.append(summary, status);
  document.querySelector('.page-content')?.append(settings);
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try {
      const state = await (await fetch('/api/creator')).json();
      if (state.product !== 'little-orbit.creator' || state.status !== 'ready') throw new Error('服务状态无法确认');
      const response = await fetch('/api/creator/stop', {method:'POST',headers:{'X-Creator-Token':state.shutdownToken}});
      if (!response.ok) throw new Error('停止请求未接受');
      text.textContent = '工坊正在关闭；正在生成的候选保存后退出。桌宠播放不受影响，已保存作品仍保留。';
    } catch (error) { text.textContent = `未关闭工坊：${error.message}`; stop.disabled = false; }
  });
})();
