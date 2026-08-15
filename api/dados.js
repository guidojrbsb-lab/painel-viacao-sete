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
// POST /api/dados?setor=...&chunk=I&total=N&uploadId=X , corpo = um PEDAÇO em texto
//      puro (Content-Type: text/plain) do JSON da base (mesmo formato que
//      exportarBaseCompleta() já gera em cada painel local), header
//      "Authorization: Bearer <SYNC_TOKEN>"
//   -> grava (sobrescrevendo) a base mais recente daquele setor no Blob. Só os 4
//      painéis administrativos (locais) conhecem o token -- chamado automaticamente
//      de dentro de saveDB() depois de cada gravação bem-sucedida no IndexedDB/
//      localStorage local (fire-and-forget: nunca trava nem quebra o uso normal do
//      painel se a rede cair ou a API estiver fora do ar).
//
//      Por que em pedaços: o Vercel limita o tamanho do corpo de uma Serverless
//      Function (~4,5 MB), e as bases do Comercial/Financeiro já passam disso.
//      Descoberto em 2026-08-15 quando a migração inicial falhou com "Failed to
//      fetch" só nesses 2 setores maiores (Manutenção e Operação, menores, passaram
//      direto num POST só). Cada painel local agora fatia o JSON em pedaços de
//      ~3,5 MB antes de mandar; quando chunk=I é o último (I === total-1), esta
//      função junta todos os pedaços já recebidos (gravados temporariamente em
//      dados/_tmp/) na ordem certa, valida como JSON, grava o arquivo final e apaga
//      os pedaços temporários. Se total=1 (ou nem vier), trata como POST único
//      (comportamento antigo, sem fragmentação) -- é o caso normal pra Manutenção e
//      Operação, que nunca chegam perto do limite.
//
// Environment Variables necessárias no Vercel (Settings > Environment Variables):
//   SYNC_TOKEN = mesmo valor gravado como SYNC_TOKEN no topo de cada painel local
//   (BLOB_READ_WRITE_TOKEN é injetada automaticamente pelo Vercel quando você conecta
//   um Blob Store ao projeto -- não precisa criar essa na mão.)
import { put, head, del } from '@vercel/blob';

const SETORES_VALIDOS = new Set(['comercial', 'financeiro', 'operacao', 'manutencao']);

function caminhoDoSetor(setor) {
  return 'dados/' + setor + '.json';
}

function caminhoDoPedaco(setor, uploadId, indice) {
  return 'dados/_tmp/' + setor + '-' + uploadId + '-' + indice + '.txt';
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

    const totalChunks = req.query.total !== undefined ? parseInt(req.query.total, 10) : 1;
    const chunkIndex = req.query.chunk !== undefined ? parseInt(req.query.chunk, 10) : 0;
    const uploadId = String(req.query.uploadId || 'unico');

    // req.body ja vem como string quando o painel manda Content-Type: text/plain
    // (comportamento padrao do runtime Node da Vercel); o fallback cobre o caso de
    // algum cliente antigo ainda mandar JSON puro sem fragmentar.
    const corpo = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    try {
      if (!totalChunks || totalChunks <= 1) {
        await put(caminho, corpo, {
          access: 'public',
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        res.status(200).json({ ok: true });
        return;
      }

      // Fatiado: guarda este pedaco temporariamente.
      await put(caminhoDoPedaco(setor, uploadId, chunkIndex), corpo, {
        access: 'public',
        contentType: 'text/plain',
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      if (chunkIndex < totalChunks - 1) {
        res.status(200).json({ ok: true, chunk: chunkIndex, aguardandoDemais: true });
        return;
      }

      // Ultimo pedaco chegou: junta todos na ordem certa.
      let completo = '';
      for (let i = 0; i < totalChunks; i++) {
        const meta = await head(caminhoDoPedaco(setor, uploadId, i));
        const r = await fetch(meta.url);
        completo += await r.text();
      }

      JSON.parse(completo); // valida antes de sobrescrever o arquivo bom

      await put(caminho, completo, {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      // Limpeza dos pedacos temporarios -- nao trava a resposta se falhar.
      for (let i = 0; i < totalChunks; i++) {
        del(caminhoDoPedaco(setor, uploadId, i)).catch(() => {});
      }

      res.status(200).json({ ok: true, concluido: true });
    } catch (e) {
      console.error('Erro ao gravar no Vercel Blob', e);
      res.status(500).json({ erro: 'Falha ao gravar dados: ' + e.message });
    }
    return;
  }

  res.status(405).json({ erro: 'Método não permitido.' });
}
