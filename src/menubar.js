// The app's top bar (all tabs): the name and menus on the left, the tabs on the right. Menus behave like a
// desktop app's: click to open, hover to switch while one is open, click an item to run it, Esc / outside
// click to close. Items: { label (string | () => string), key (shortcut shown), action, enabled?(), checked?() } | '-'
const PAGES = [['/', 'Characters'], ['/scenario.html', 'Scenarios'], ['/names.html', 'Names'], ['/editor.html', 'Editor'], ['/slides.html', 'Slides'], ['/items.html', 'Items']];

export function menubar(menus = []) {
  const here = location.pathname.replace(/index\.html$/, '') || '/';
  const bar = document.createElement('nav'); bar.className = 'menubar';
  bar.innerHTML = `<span class="brand">DREAMARE</span><span class="menus"></span><span class="pages">${PAGES.map(([h, l]) => `<a href="${h}" class="${h === here ? 'on' : ''}">${l}</a>`).join('')}</span>`;
  const menusEl = bar.querySelector('.menus');
  let open = null;
  const close = () => { open?.classList.remove('open'); open = null; };
  for (const m of menus) {
    const el = document.createElement('span'); el.className = 'menu';
    el.innerHTML = `<span class="title">${m.label}</span><div class="drop"></div>`;
    const drop = el.querySelector('.drop');
    const fill = () => { // labels / states can change (Play <-> Stop), so the list is rebuilt on every open
      drop.replaceChildren(...m.items.map((it) => {
        if (it === '-') { const hr = document.createElement('div'); hr.className = 'sep'; return hr; }
        const row = document.createElement('div'), on = it.enabled ? it.enabled() : true;
        row.className = 'item' + (on ? '' : ' off');
        row.innerHTML = `<span class="check">${it.checked?.() ? '✓' : ''}</span><span>${typeof it.label === 'function' ? it.label() : it.label}</span><span class="key">${it.key || ''}</span>`;
        if (on) row.onclick = (e) => { e.stopPropagation(); close(); it.action(); };
        return row;
      }));
    };
    el.querySelector('.title').onclick = (e) => { e.stopPropagation(); if (open === el) close(); else { close(); fill(); el.classList.add('open'); open = el; } };
    el.onmouseenter = () => { if (open && open !== el) { close(); fill(); el.classList.add('open'); open = el; } };
    menusEl.appendChild(el);
  }
  addEventListener('pointerdown', (e) => { if (open && !bar.contains(e.target)) close(); }, true);
  addEventListener('keydown', (e) => { if (e.code === 'Escape') close(); });
  document.body.prepend(bar);
  document.body.classList.add('has-menubar');
  return bar;
}
