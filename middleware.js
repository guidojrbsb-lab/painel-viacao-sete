// Protege TODO o site (index.html, painel_publico.html e qualquer outro arquivo do
// mesmo repositório) atrás de usuário/senha, verificados aqui no servidor do Vercel
// ANTES de qualquer conteúdo ser enviado ao navegador. Diferente de uma máscara em
// JavaScript, quem não souber a senha nunca chega a baixar o HTML — não tem "Ver
// código-fonte" que escape disso.
//
// O usuário e a senha NÃO ficam escritos aqui (este arquivo pode ficar num repositório
// público no GitHub) — eles vêm das Environment Variables do projeto no Vercel
// (SITE_USER e SITE_PASS). Configure-as em: Vercel → seu projeto → Settings →
// Environment Variables, antes de publicar este arquivo.
import { next } from '@vercel/functions';

export const config = {
  matcher: '/:path*',
};

export default function middleware(request) {
  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      let user = '', pass = '';
      try {
        [user, pass] = atob(encoded).split(':');
      } catch (e) {
        // credencial mal formada — cai para o 401 abaixo
      }
      if (user === process.env.SITE_USER && pass === process.env.SITE_PASS) {
        return next();
      }
    }
  }

  return new Response('Autenticação necessária.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Painel Viação Sete"',
    },
  });
}
