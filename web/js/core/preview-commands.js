(function (global) {
  'use strict';
  const TurndownService = typeof module === 'object' ? require('turndown') : global.TurndownService;
  const gfm = typeof module === 'object' ? require('turndown-plugin-gfm') : global.turndownPluginGfm;
  const markdownit = typeof module === 'object' ? require('../../libs/markdown-it.min.js') : global.markdownit;
  const markdown = markdownit({ html: true });
  const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
  converter.use(gfm.gfm);
  converter.addRule('stuartStrike', { filter: ['del', 's', 'strike'], replacement: content => '~~' + content + '~~' });
  converter.addRule('formattedInlineCode', {
    filter: node => ['STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'STRIKE', 'U', 'SPAN', 'A'].includes(node.nodeName) && Boolean(node.querySelector('code')),
    replacement: (content, node) => node.outerHTML
  });
  converter.keep(['u', 'ins', 'mark', 'span']);

  function correspondingNode(root, copy, node) {
    const indices = [];
    while (node !== root) {
      indices.push([...node.parentNode.childNodes].indexOf(node));
      node = node.parentNode;
    }
    for (const index of indices.reverse()) copy = copy.childNodes[index];
    return copy;
  }

  function clippedRange(range, node) {
    if (!range.intersectsNode(node)) return null;
    const result = node.ownerDocument.createRange();
    result.selectNodeContents(node);
    if (range.compareBoundaryPoints(0, result) > 0) result.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(2, result) < 0) result.setEnd(range.endContainer, range.endOffset);
    return result.collapsed ? null : result;
  }

  function meaningful(fragment) {
    return Boolean(fragment.textContent.trim() || fragment.querySelector('img, hr, input, svg, canvas, video, audio'));
  }

  function coversContent(range, node) {
    const prefix = node.ownerDocument.createRange(), suffix = prefix.cloneRange();
    prefix.selectNodeContents(node); prefix.setEnd(range.startContainer, range.startOffset);
    suffix.selectNodeContents(node); suffix.setStart(range.endContainer, range.endOffset);
    return !meaningful(prefix.cloneContents()) && !meaningful(suffix.cloneContents());
  }

  function editPreviewSelection({ preview, selection, source, documentId, revision, format }) {
    if (!selection.rangeCount || selection.isCollapsed || !preview.contains(selection.anchorNode) || !preview.contains(selection.focusNode)) return null;
    const original = selection.getRangeAt(0);
    const copy = preview.cloneNode(true), document = preview.ownerDocument;
    const range = document.createRange();
    range.setStart(correspondingNode(preview, copy, original.startContainer), original.startOffset);
    range.setEnd(correspondingNode(preview, copy, original.endContainer), original.endOffset);
    let wrapper;
    if (format) {
      const template = document.createElement('template');
      template.innerHTML = markdown.renderInline(format.before + 'StuartSelectionText' + format.after);
      wrapper = template.content.firstElementChild;
      if (!wrapper || template.content.childNodes.length !== 1 || wrapper.textContent !== 'StuartSelectionText') throw new Error('所选格式无法应用，请检查格式或链接地址');
      wrapper.replaceChildren();
    }
    const changes = [];
    for (const block of [...copy.children].filter(node => node.classList.contains('md-block'))) {
      const selected = clippedRange(range, block);
      if (!selected) continue;
      const fragment = selected.cloneContents();
      if (!fragment.textContent.length && !meaningful(fragment)) continue;
      if (block.dataset.documentId !== documentId || Number(block.dataset.revision) !== revision) throw new Error('选区与当前文档版本不一致');
      const start = Number(block.dataset.sourceOffset), end = Number(block.dataset.sourceEnd);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) throw new Error('选区源码位置无效');
      const complete = coversContent(selected, block);
      let text = '';
      if (format || !complete) {
        if (block.querySelector('.katex, .mermaid-diagram, .mermaid-src, .mermaid-fallback, textarea, svg, .footnote-ref, .footnotes') || (format && block.querySelector('pre'))) {
          throw new Error('图表、公式及特殊内容请在源码中修改；本次操作未修改正文');
        }
        if (format) {
          if (wrapper.tagName === 'A' && [...block.querySelectorAll('a')].some(link => clippedRange(selected, link)?.toString())) throw new Error('选区包含已有链接，请在源码中修改链接地址');
          const walker = document.createTreeWalker(block, 4), portions = [];
          while (walker.nextNode()) {
            const part = clippedRange(selected, walker.currentNode);
            const equivalent = { STRONG: 'strong,b', EM: 'em,i', S: 's,del,strike', DEL: 's,del,strike', CODE: 'code', U: 'u' }[wrapper.tagName];
            if (equivalent && walker.currentNode.parentElement.closest(equivalent)) continue;
            if (part && part.toString().trim()) portions.push(part);
          }
          for (const part of portions.reverse()) {
            const element = wrapper.cloneNode(false);
            const code = part.startContainer.parentElement.closest('code');
            if (code) {
              const prefix = document.createRange(), suffix = document.createRange();
              prefix.selectNodeContents(code); prefix.setEnd(part.startContainer, part.startOffset);
              suffix.selectNodeContents(code); suffix.setStart(part.endContainer, part.endOffset);
              const before = code.cloneNode(false), middle = code.cloneNode(false), after = code.cloneNode(false);
              before.append(prefix.cloneContents()); middle.append(part.cloneContents()); after.append(suffix.cloneContents());
              element.append(middle);
              code.replaceWith(...(before.textContent ? [before] : []), element, ...(after.textContent ? [after] : []));
            } else {
              element.append(part.extractContents());
              part.insertNode(element);
            }
          }
          // 合并相邻的相同格式，避免 Markdown 分隔符连续出现。
          block.normalize();
          for (const element of [...block.querySelectorAll('strong,em,s,del,u,span,a,code')].reverse()) {
            let next = element.nextSibling;
            while (next?.nodeType === 1 && element.cloneNode(false).isEqualNode(next.cloneNode(false))) {
              element.append(...next.childNodes);
              next.remove();
              next = element.nextSibling;
            }
          }
        } else if (block.querySelector('table')) {
          // 保留单元格结构，分别清除各个单元格中实际选中的内容。
          const portions = [...block.querySelectorAll('td, th')].map(cell => clippedRange(selected, cell)).filter(Boolean);
          for (const part of portions.reverse()) part.deleteContents();
        } else {
          selected.deleteContents();
        }
        text = converter.turndown(block);
        if (meaningful(block) && !text.trim()) throw new Error('选区修改后的 Markdown 转换为空，正文未修改');
        const separators = source.slice(start, end).match(/\n+$/)?.[0] || '';
        if (text) text += separators;
      }
      changes.push({ start, end, text });
    }
    if (!changes.length) return null;
    let result = source;
    for (const change of changes.reverse()) result = result.slice(0, change.start) + change.text + result.slice(change.end);
    return result.trim() ? result : '';
  }

  const api = { editPreviewSelection };
  if (typeof module === 'object') module.exports = api;
  global.StuartCore = Object.assign(global.StuartCore || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
