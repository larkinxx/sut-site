// Печать INNSIDER — круглое клеймо с монограммой «IS.» и девизом «FIDES · IN · FACTIS» («Доверие — в фактах»).
// Ставится на сертификат проверки рядом с QR-кодом. Встроенный SVG: шрифт Playfair берётся со страницы,
// цвет — currentColor (тёмная тема и печать без отдельных правил).
export function sealSvg({ size = 132, label = 'Печать INNSIDER' } = {}) {
  return `<svg class="seal" xmlns="http://www.w3.org/2000/svg" viewBox="-160 -160 320 320" width="${size}" height="${size}" role="img" aria-label="${label}">
<g fill="none" stroke="currentColor" stroke-linecap="round"><circle r="150" stroke-width="1.6"/><circle r="141" stroke-width=".9"/><circle r="104" stroke-width=".9"/><circle r="97" stroke-width="1.6"/></g>
<defs><path id="seal-top" d="M-122,0 A122,122 0 0 1 122,0"/><path id="seal-bot" d="M-122,0 A122,122 0 0 0 122,0"/></defs>
<g fill="currentColor" font-family="'Playfair Display',Didot,Georgia,serif">
<text font-size="17" letter-spacing="8.5"><textPath href="#seal-top" startOffset="50%" text-anchor="middle">INNSIDER</textPath></text>
<text font-size="12" letter-spacing="4.3" dy="10"><textPath href="#seal-bot" startOffset="50%" text-anchor="middle">FIDES · IN · FACTIS</textPath></text>
<circle cx="-122" cy="0" r="3"/><circle cx="122" cy="0" r="3"/>
<text x="-4" y="38" text-anchor="middle" font-size="104" letter-spacing="-6">IS</text><circle cx="44" cy="32" r="6"/>
<line x1="-46" y1="56" x2="46" y2="56" stroke="currentColor" stroke-width=".8"/>
<text x="0" y="74" text-anchor="middle" font-family="Jost,'Helvetica Neue',Arial,sans-serif" font-size="9" letter-spacing="3.6">MMXXVI</text>
</g></svg>`;
}
