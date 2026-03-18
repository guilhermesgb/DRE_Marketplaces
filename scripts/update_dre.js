import fs from 'fs';
import path from 'path';
import cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('SUPABASE_URL ou SUPABASE_KEY não está definido. Apenas gera JSON/HTML.');
}

const htmlPath = path.resolve('dre_marketplaces_1.html');
const html = fs.readFileSync(htmlPath, 'utf-8');
const $ = cheerio.load(html);

function parseMoney(value) {
  if (!value) return 0;
  return Number(value
    .replace(/[R$\s\.]/g, '')
    .replace(',', '.')
    .replace('(', '-')
    .replace(')', '')) || 0;
}

function parsePct(value) {
  if (!value) return 0;
  return Number(value.replace('%', '').replace(',', '.')) || 0;
}

// 1) Extrai dados da tabela consolidada (por canal)
const data = [];
$('#pane-consolidado table tbody tr').each((i, el) => {
  const cells = $(el).find('td');
  if (cells.length === 7 && i < 9) {
    // apenas os 9 canais
    const canal = $(cells[0]).text().trim();
    const faturamento = parseMoney($(cells[1]).text().trim());
    const rec_liq = parseMoney($(cells[2]).text().trim());
    const cmv = parseMoney($(cells[3]).text().trim());
    const lb = parseMoney($(cells[4]).text().trim());
    data.push({ canal, faturamento, rec_liq, cmv, lb });
  }
});

if (data.length === 0) {
  throw new Error('Não foi possível extrair dados da tabela consolidada.');
}

// 2) Pega pedidos da coluna comparativo (se houver) ou hardcode quando falta
const pedidosByCanal = {};
$('#pane-comparativo table tbody tr').each((_i, row) => {
  const cells = $(row).find('td');
  if (cells.length >= 2) {
    const canal = $(cells[0]).text().trim().replace('un', '').replace('~', '').trim();
    const pedidosRaw = $(cells[1]).text().trim().replace('~', '').replace('un', '').trim();
    const n = Number(pedidosRaw.replace('.', '').replace(',', '.'));
    if (!Number.isNaN(n) && n > 0) pedidosByCanal[canal] = n;
  }
});

const totalFaturamento = data.reduce((sum, c) => sum + c.faturamento, 0);
const totalPedidos = Object.values(pedidosByCanal).reduce((sum, v) => sum + v, 0); // base nos dados de comparativo
const totalRateio = 5000;
const totalEmbalagem = totalPedidos;

// 3) Calcular rateio+embalagem + LB ajustado
for (const row of data) {
  row.pedidos = pedidosByCanal[row.canal] || 0;
  row.rateio = Number(((row.faturamento / totalFaturamento) * totalRateio).toFixed(2));
  row.embalagem = Number((row.pedidos * 1).toFixed(2));
  row.lb_ajustado = Number((row.lb - row.rateio - row.embalagem).toFixed(2));
}

const consolidado = {
  total_faturamento: totalFaturamento,
  total_rec_liq: data.reduce((s, c) => s + c.rec_liq, 0),
  total_cmv: data.reduce((s, c) => s + c.cmv, 0),
  total_lb: data.reduce((s, c) => s + c.lb, 0),
  total_rateio,
  total_embalagem,
  total_lb_ajustado: Number(data.reduce((s, c) => s + c.lb_ajustado, 0).toFixed(2))
};

// 4) Atualiza JSON local
const output = { consolidado, canais: data };
fs.writeFileSync('dre_marketplaces_data.json', JSON.stringify(output, null, 2), 'utf-8');
console.log('Arquivo dre_marketplaces_data.json gerado.');

// 5) Atualiza HTML com o novo bloco de custo no consolidado (somente se não existe ainda)
const consolidadoTable = $('#pane-consolidado table tbody');
if (consolidadoTable.find('tr:contains("Rateio Agência")').length === 0) {
  consolidadoTable.append(`
    <tr>
      <td class="indent">(-) Rateio Agência (R$ 5.000)</td>
      <td>-</td><td>-</td><td>-</td><td class="neg">(5.000,00)</td><td>-</td><td>-</td>
    </tr>
    <tr>
      <td class="indent">(-) Embalagem (R$ 1,00/pedido)</td>
      <td>-</td><td>-</td><td>-</td><td class="neg">(${totalEmbalagem.toFixed(2)})</td><td>-</td><td>-</td>
    </tr>
    <tr class="total">
      <td>Total Ajustado</td>
      <td>${totalFaturamento.toFixed(2)}</td>
      <td>${output.consolidado.total_rec_liq.toFixed(2)}</td>
      <td>${output.consolidado.total_cmv.toFixed(2)}</td>
      <td>${output.consolidado.total_lb_ajustado.toFixed(2)}</td>
      <td>${((output.consolidado.total_lb_ajustado / output.consolidado.total_rec_liq) * 100).toFixed(1)}%</td>
      <td>100%</td>
    </tr>
  `);
  fs.writeFileSync(htmlPath, $.html(), 'utf-8');
  console.log('HTML atualizado com consolidado ajustado.');
}

// 6) Upsert no Supabase (caso credenciais existentes)
if (SUPABASE_URL && SUPABASE_KEY) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  (async () => {
    const table = 'dre_marketplaces';
    const { error: errorUpsert } = await supabase.from(table).upsert(data.map(c => ({
      canal: c.canal,
      faturamento: c.faturamento,
      pedidos: c.pedidos,
      rec_liq: c.rec_liq,
      cmv: c.cmv,
      lb: c.lb,
      rateio: c.rateio,
      embalagem: c.embalagem,
      lb_ajustado: c.lb_ajustado
    })), { onConflict: ['canal'] });

    if (errorUpsert) {
      console.error('Falha no upsert Supabase:', errorUpsert.message);
      process.exit(1);
    }

    const { error: cError } = await supabase.from('dre_marketplaces_consolidado').upsert([
      {
        id: 1,
        faturamento: consolidado.total_faturamento,
        rec_liq: consolidado.total_rec_liq,
        cmv: consolidado.total_cmv,
        lb: consolidado.total_lb,
        rateio: consolidado.total_rateio,
        embalagem: consolidado.total_embalagem,
        lb_ajustado: consolidado.total_lb_ajustado
      }
    ], { onConflict: ['id'] });

    if (cError) {
      console.error('Falha no upsert consolidado Supabase:', cError.message);
      process.exit(1);
    }

    console.log('Supabase atualizado com sucesso.');
  })();
} else {
  console.log('Credenciais Supabase não fornecidas. Processo finalizado localmente.');
}
