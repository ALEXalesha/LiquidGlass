const { PAGES } = require('./serve');

const FILES = PAGES.map(p => p.file);

function cycle(active, step){
  const i = FILES.indexOf(active);
  return FILES[((i + step) % FILES.length + FILES.length) % FILES.length];
}

/* code first, so Ctrl+1 still works on layouts where the digit row types
   something else; key as a fallback for events that carry no code */
function tabForKey(input, active){
  if(input.type !== 'keyDown' || input.alt || !(input.control || input.meta)) return null;
  const digit = /^Digit(\d)$/.exec(input.code || '')?.[1] ?? (/^\d$/.test(input.key) ? input.key : null);
  if(digit !== null){
    if(input.shift) return null;
    return FILES[Number(digit) - 1] ?? null;
  }
  if(input.key === 'Tab' && input.control) return cycle(active, input.shift ? -1 : 1);
  if(input.key === 'PageDown' && !input.shift) return cycle(active, 1);
  if(input.key === 'PageUp' && !input.shift) return cycle(active, -1);
  return null;
}

/* the harnesses announce their verdict in the title */
function statusFor(title){
  if(/^ok \d/.test(title)) return 'ok';
  if(/^(FAIL|BROKE) \d/.test(title)) return 'fail';
  return '';
}

const titleFor = title => title && !/^[a-z]+:\/\//.test(title) ? title : 'Liquid Glass';

module.exports = { cycle, tabForKey, statusFor, titleFor };
