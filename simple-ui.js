/* Keep the existing generation controls, but reveal technical routes on demand. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const content = document.querySelector('#studio-page .page-content');
  if (!content) return;
  document.body.classList.add('simple-experience');
  const wrap = (node, title, className = '') => {
    if (!node) return null;
    const details = document.createElement('details');
    details.className = `simple-disclosure ${className}`;
    const summary = document.createElement('summary'); summary.textContent = title;
    node.before(details); details.append(summary, node); return details;
  };
  const welcome = document.querySelector('.welcome-row h1');
  if (welcome) welcome.textContent = '定制你的桌面伙伴';
  const subtitle = document.querySelector('.welcome-subtitle');
  if (subtitle) subtitle.textContent = '添加照片，写下动作描述，预览满意后使用。连接 AI 工具请从桌宠右键菜单进入。';
  document.querySelector('[data-page="studio"] span:nth-child(2)').textContent = '自定义';
  document.querySelector('[data-page="characters"] span:nth-child(2)').textContent = '我的宠物';
  const hero = document.querySelector('.hero-grid');
  const heading = document.createElement('h2'); heading.className = 'simple-step-title';
  heading.textContent = '1 · 添加宠物照片'; hero.before(heading);
  byId('replace-photo').textContent = '选择主照片';
  byId('replace-photo').title = '选择一张主照片，其他角度可在下方添加';
  byId('start-creation').querySelector('span').textContent = '保存宠物资料';

  const motion = document.querySelector('.head-tilt-workshop');
  if (motion) {
    const actionStage = document.createElement('section'); actionStage.className = 'simple-action-stage';
    const title = document.createElement('h2'); title.textContent = '2 · 写描述，生成动作';
    const intro = document.createElement('p');
    intro.textContent = '当前本机模型可试做眨眼、歪头；任意新动作仍需相应生成后端。生成完成后，在下方预览并决定是否使用。';
    actionStage.append(title, intro);
    hero.after(actionStage);
    const prompt = byId('head-tilt-prompt').closest('label');
    const generate = byId('model-bundle-run');
    generate.textContent = '生成眨眼和歪头预览'; generate.className = 'primary-button';
    const status = byId('model-head-status');
    const note = document.createElement('p'); note.className = 'simple-route-note';
    note.textContent = '这个模板按选定幅度生成动作，描述用于保留创作意图。需要改变模板参数或解释歪头描述时，展开下方设置。';
    const advanced = document.createElement('details'); advanced.className = 'simple-disclosure';
    const summary = document.createElement('summary'); summary.textContent = '动作设置与其他制作方式';
    advanced.append(summary); motion.before(advanced); advanced.append(motion);
    actionStage.append(prompt, byId('head-tilt-confirm').closest('label'), generate, status, note, advanced);
    motion.querySelector('h3').textContent = '调整动作';
    const history = byId('head-tilt-history');
    if (history) actionStage.append(history);
    actionStage.append(byId('head-tilt-candidates'));
  }
  wrap(document.querySelector('.sam2-video-studio'), '其他方式：已有视频或实验生成后端');
  wrap(document.querySelector('.lower-grid'), '了解制作流程');
  const roleButton = byId('start-creation');
  if (roleButton) roleButton.title = '保存照片和描述，不会把静态照片当作已经生成的动作';
})();
