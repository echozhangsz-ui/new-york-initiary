(function () {
  'use strict';
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let busy = false;
  const load = src => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('PDF library unavailable')); };
    document.head.appendChild(script);
  });
  async function readyImages() {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const pending = [...document.querySelectorAll('img')].some(img => !img.complete || (img.dataset.wiki && !img.getAttribute('src')));
      if (!pending && !(window.exportMaps || []).some(item => item.map._tilesToLoad > 0 || item.layer.isLoading())) return;
      await pause(200);
    }
    throw new Error('Images or map tiles are still loading');
  }
  async function imageData() {
    const sources = [...new Set([...document.images].filter(img => img.currentSrc && img.naturalWidth).map(img => img.currentSrc))];
    const result = new Map();
    // Resolve CORS before creating the PDF, so missing maps never silently produce an incomplete file.
    for (let i = 0; i < sources.length; i += 8) {
      await Promise.all(sources.slice(i, i + 8).map(async src => {
        const response = await fetch(src, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Image unavailable: ' + response.status);
        const blob = await response.blob();
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        result.set(src, data);
      }));
    }
    return result;
  }
  window.downloadItineraryPDF = async function () {
    if (busy) return;
    busy = true;
    const button = document.getElementById('download-pdf');
    const status = document.getElementById('pdf-status');
    const zh = document.body.classList.contains('lang-zh');
    const text = (cn, fr) => zh ? cn : fr;
    const originalY = window.scrollY;
    const details = [...document.querySelectorAll('details')].map(el => [el, el.open]);
    const views = (window.exportMaps || []).map(item => ({ ...item, center: item.map.getCenter(), zoom: item.map.getZoom() }));
    button.disabled = true;
    document.querySelectorAll('.lang-btn').forEach(el => el.disabled = true);
    status.textContent = text('正在准备完整网页和地图…', 'Préparation de la page et des cartes…');
    try {
      await Promise.all([
        window.html2canvas ? Promise.resolve() : load('assets/vendor/html2canvas.min.js'),
        window.jspdf ? Promise.resolve() : load('assets/vendor/jspdf.umd.min.js')
      ]);
      await document.fonts.ready;
      document.body.classList.add('pdf-rendering');
      details.forEach(([el]) => el.open = true);
      window.scrollTo(0, 0);
      await nextFrame();
      views.forEach(item => { item.map.invalidateSize({ animate: false }); item.map.fitBounds(item.bounds, item.options); });
      await nextFrame();
      await readyImages();
      const images = await imageData();
      const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
      pdf.setProperties({ title: 'New York - David & Echo', subject: 'Full website itinerary with maps', author: 'David & Echo' });
      const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
      const margin = 8, usableW = pageW - margin * 2, usableH = pageH - margin * 2;
      let y = margin, pages = 1;
      const blocks = [...document.querySelectorAll('.hero,.nav-wrap,main.content > .itinerary-key,main.content > .notice,main.content > .day-card,.sources,.footer-note')];
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.classList.contains('day-card') && y > margin + .1) {
          pdf.addPage(); pages++; y = margin;
        }
        status.textContent = text(`正在生成PDF ${index + 1}/${blocks.length}…`, `Création du PDF ${index + 1}/${blocks.length}…`);
        const rect = block.getBoundingClientRect();
        // Page boundaries must avoid cutting through a map, text line, or table row.
        const protectedRects = [...block.querySelectorAll('tr,.day-titlebar,.day-heading,.day-brief,.day-map-container,p,.wx-card,summary')]
          .filter(el => !el.closest('.day-map-container') || el.classList.contains('day-map-container'))
          .map(el => { const r = el.getBoundingClientRect(); return [Math.max(0, r.top - rect.top), r.bottom - rect.top]; });
        if (block.id === 'overview' || block.id === 'weather' || block.classList.contains('hero')) protectedRects.push([0, rect.height]);
        block.querySelectorAll('table').forEach(table => {
          const r = table.getBoundingClientRect();
          protectedRects.push([r.top - rect.top, r.bottom - rect.top]);
        });
        const canvas = await window.html2canvas(block, {
          scale: 1.5, backgroundColor: '#f4f6fa', useCORS: true, logging: false,
          windowWidth: 1440, windowHeight: 1000, scrollX: 0, scrollY: 0,
          ignoreElements: el => el.matches && el.matches('.lang-switch,.download-controls,.top-link'),
          onclone: doc => {
            doc.querySelectorAll('img').forEach(img => {
              const data = images.get(img.src);
              if (data) { img.removeAttribute('srcset'); img.src = data; }
            });
            // html2canvas 1.4 cannot parse color-mix(); use the same theme at a 10% tint.
            doc.querySelectorAll('.brief-card.primary').forEach(el => {
              const color = getComputedStyle(el.closest('.day-card')).getPropertyValue('--theme').trim();
              if (/^#[0-9a-f]{6}$/i.test(color)) {
                const rgb = [1, 3, 5].map(i => Math.round(parseInt(color.slice(i, i + 2), 16) * .1 + 255 * .9));
                el.style.background = `linear-gradient(135deg,rgb(${rgb.join(',')}),#fff)`;
              }
            });
          }
        });
        const factor = usableW / canvas.width;
        const scale = canvas.height / rect.height;
        let start = 0;
        while (start < canvas.height) {
          let end = Math.min(canvas.height, start + Math.floor((pageH - margin - y) / factor));
          for (const [top, bottom] of protectedRects) {
            const a = Math.floor(top * scale), b = Math.ceil(bottom * scale);
            if (a < end && b > end && a >= start) end = Math.min(end, a);
          }
          if (end <= start + 1) {
            if (y > margin + .1) { pdf.addPage(); pages++; y = margin; continue; }
            // An unusually tall indivisible block gets its own proportionally scaled page.
            end = Math.min(canvas.height, Math.max(...protectedRects.filter(([a]) => Math.floor(a * scale) <= start + 1).map(([, b]) => Math.ceil(b * scale)), start + Math.floor(usableH / factor)));
            if (canvas.height - end < 40 * scale) end = canvas.height;
          }
          const slice = document.createElement('canvas');
          slice.width = canvas.width; slice.height = end - start;
          slice.getContext('2d').drawImage(canvas, 0, start, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
          const fit = Math.min(factor, usableH / slice.height);
          pdf.addImage(slice.toDataURL('image/jpeg', .94), 'JPEG', margin, y, slice.width * fit, slice.height * fit);
          y += slice.height * fit;
          slice.width = slice.height = 0;
          start = end;
          if (start < canvas.height) { pdf.addPage(); pages++; y = margin; }
        }
        canvas.width = canvas.height = 0;
        y += 3;
        if (y > pageH - margin - 5 && index < blocks.length - 1) { pdf.addPage(); pages++; y = margin; }
        await nextFrame();
      }
      const filename = 'New-York-David-Echo-' + (zh ? 'ZH' : 'FR') + '-full.pdf';
      await pdf.save(filename, { returnPromise: true });
      status.textContent = text(`已生成完整PDF（${pages}页），请查看下载。`, `PDF complet créé (${pages} pages). Consultez vos téléchargements.`);
    } catch (error) {
      console.error('PDF export failed', error);
      status.textContent = text('生成失败：请等待地图和图片加载完成后重试，并保持网络连接。', 'Échec : attendez le chargement des cartes et images, puis réessayez avec une connexion active.');
    } finally {
      document.body.classList.remove('pdf-rendering');
      details.forEach(([el, open]) => el.open = open);
      await nextFrame();
      views.forEach(item => { item.map.invalidateSize({ animate: false }); item.map.setView(item.center, item.zoom, { animate: false }); });
      window.scrollTo(0, originalY);
      button.disabled = false;
      document.querySelectorAll('.lang-btn').forEach(el => el.disabled = false);
      busy = false;
    }
  };
})();
