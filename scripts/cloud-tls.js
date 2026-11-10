import { X509Certificate } from 'node:crypto';
import { rootCertificates, getCACertificates } from 'node:tls';

// Servers can send a cross-signed root without sending its trust anchor. Select
// only a current self-signed root from Node's trusted CA store whose public key
// matches the chain, or whose signature verifies the chain's final issuer.
export function selectTrustedRoot(chain, trusted = [...getCACertificates('default'), ...rootCertificates], now = Date.now()) {
  const roots = trusted.map(pem => ({pem,cert:new X509Certificate(pem)})).filter(({cert}) => cert.subject === cert.issuer && cert.verify(cert.publicKey) && Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now);
  for (const raw of chain) {
    const node = new X509Certificate(raw);
    for (const {pem,cert} of roots) {
      const sameKey = node.subject === cert.subject && node.publicKey.export({type:'spki',format:'der'}).equals(cert.publicKey.export({type:'spki',format:'der'}));
      const signed = node.issuer === cert.subject && node.verify(cert.publicKey);
      if (sameKey || signed) return pem.trim()+'\n';
    }
  }
  throw Error('Could not obtain the verified Supabase root certificate');
}
