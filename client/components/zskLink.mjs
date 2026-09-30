import { buildZskUrl } from '../../shared/zsk.mjs';

export function createZskLink(rawInn) {
  const zsk = buildZskUrl(rawInn);
  if (!zsk) return null;

  const a = document.createElement('a');
  a.href = zsk.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer external';
  a.referrerPolicy = 'no-referrer';
  a.className = 'btn btn-outline cbr-zsk-link';
  a.textContent = 'Проверить в ЗСК ЦБ';
  a.title = `ИНН ${zsk.inn} будет скопирован — вставьте его в форму на сайте ЦБ`;
  a.dataset.inn = zsk.inn;

  a.addEventListener('click', () => {
    navigator.clipboard?.writeText(zsk.inn).then(
      () => showToast?.(`ИНН ${zsk.inn} скопирован`),
      () => {},
    );
  });
  return a;
}
