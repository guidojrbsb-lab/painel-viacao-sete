// API de sincronização automática entre os 4 painéis locais (admin) e os 4 painéis
// públicos (somente leitura) -- "Opção 3" aprovada pelo usuário em 2026-08-15, pra
// não precisar mais exportar base + pedir pro Claude regenerar o _publico.html +
// subir manualmente no GitHub toda vez que algo muda em qualquer setor.
//
// Armazenamento: Vercel Blob (não Vercel KV/Redis) -- trocado em 2026-08-15 porque a
// tela de "Create a database" do Vercel não oferece mais um "KV" nativo (virou
// integração de terceiro via Upstash), e porque a base do Comercial/Financeiro já
// passa de vários MB, acima do que é confortável num valor de Redis. Blob é feito
// pra arquivo (sem esse limite) e é nativo do Vercel, sem conta externa.
//
// GET  /api/dados?setor=comercial|financeiro|operacao|manutencao
//   -> devolve o JSON mais recente daquele setor (leitura pública, sem token --
//      é o mesmo dado que já era embutido publicamente em cada _publico.html, só
//      que agora ao vivo em vez de "assado" no HTML no momento da última publicação
//      manual). Devolve null se esse setor ainda não recebeu nenhuma sincronização.
//
// POST /api/dados?setor=... , corpo = JSON da base (mesmo formato que
//      exportarBaseCompleta() já gera em cada painel local), header
//      "Authorization: Bearer <SYNC_TOKEN>"
//   -> grava (sobrescrevendo) a base mais recente daquele setor no Blob. Só os 4
//      painéis administrativos (locais) conhecem o token -- chamado automaticamente
//      de dentro de saveDB() depois de cada gravação bem-sucedida no IndexedDB/
//      localStorage local (fire-and-forget: nunca trava nem quebra o uso normal do
//      painel se a rede cair ou a API estiver fora do ar).
//
// Environment Variables necessárias no Vercel (Settings > Environment Variables):
//   SYNC_TOKEN = mesmo valor gravado como SYNC_TOKEN no topo de cada painel local
//   (BLOB_READ_WRITE_TOKEN é injetada automaticamente pelo Vercel quando você conecta
//   um Blob Store ao projeto -- não precisa criar essa na mão.)
import { put, head } from '@vercel/blob';

const SETORES_VALIDOS = new Set(['comercial', 'financeiro', 'operacao', 'manutencao']);

function caminhoDoSetor(setor) {
  return 'dados/' + setor + '.json';
}

export default async function handler(req, res) {
  // CORS liberado (só pra este endpoint) -- o painel Comercial local ("Painel Viação
  // Sete.html") mora fora da pasta publicada no Vercel e é aberto direto como arquivo
  // (file://), então o fetch() de lá pra cá é cross-origin de verdade (origin "null").
  // Sem isso o navegador bloqueia a resposta antes de chegar no JS. Os outros 3
  // painéis locais (dentro da pasta publicada) já são same-origin quando abertos pelo
  // link, então o CORS não muda nada pra eles -- só destrava o caso do Comercial.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const setor = String(req.query.setor || '').toLowerCase();
  if (!SETORES_VALIDOS.has(setor)) {
    res.status(400).json({ erro: 'Parâmetro "setor" inválido. Use: comercial, financeiro, operacao ou manutencao.' });
    return;
  }
  const caminho = caminhoDoSetor(setor);

  if (req.method === 'GET') {
    try {
      const meta = await head(caminho);
      const resp = await fetch(meta.url, { cache: 'no-store' });
      if (!resp.ok) { res.status(200).json(null); return; }
      const dados = await resp.json();
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(dados);
    } catch (e) {
      // head() lança erro quando o blob ainda não existe (setor nunca sincronizado) --
      // trata como "sem dado ao vivo ainda" em vez de erro, pro painel público cair
      // no fallback do EMBEDDED_DB normalmente.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(null);
    }
    return;
  }

  if (req.method === 'POST') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!process.env.SYNC_TOKEN || token !== process.env.SYNC_TOKEN) {
      res.status(401).json({ erro: 'Não autorizado.' });
      return;
    }
    try {
      await put(caminho, JSON.stringify(req.body), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Erro ao gravar no Vercel Blob', e);
      res.status(500).json({ erro: 'Falha ao gravar dados.' });
    }
    return;
  }

  res.status(405).json({ erro: 'Método não permitido.' });
}
