import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import styles from './page.module.css';

const inter = Inter({ subsets: ['latin'], display: 'swap' });
const artwork = '/images/marketing/';

export const metadata: Metadata = {
  title: 'Smart Housing',
  description: 'Catch the slow drain before it becomes a clog.',
};

const steps = [
  { image: 'sensor.png', title: 'A sensor times every drain', description: 'A removable water-level sensor measures how quickly water recedes after each use.' },
  { image: 'baseline.png', title: 'Software learns what’s normal', description: 'It adapts to each drain, including different starting water levels, so there are no false alarms.' },
  { image: 'notification.png', title: 'You get the early warning', description: 'Persistent slowing is flagged while it’s still a nuisance, not an emergency.' },
];

function NavigationLinks() {
  return <>
    <a href="#how-it-works">How it works</a>
    <a href="#for-hotels">For hotels</a>
    <a href="/insights">Live demo</a>
    <a href="/">Pricing</a>
    <a href="/insights" className={styles.login}>Log in</a>
    <a href="/" className={styles.primary}>Book a demo</a>
  </>;
}

function WaterDivider() {
  return <div className={styles.wave} aria-hidden="true">
    <img src={`${artwork}wave.png`} width="1280" height="60" alt="" />
  </div>;
}

export default function Home() {
  return <div className={`${styles.page} ${inter.className}`}>
    <a href="#main" className={styles.skipLink}>Skip to content</a>
    <header className={styles.header}>
      <a href="/" className={styles.brand} aria-label="Company Name home">
        <img src={`${artwork}logo.png`} width="32" height="32" alt="" />
        <span>Company Name</span>
      </a>
      <nav className={styles.navigation} aria-label="Main navigation"><NavigationLinks /></nav>
      <details className={styles.mobileMenu}>
        <summary>Menu</summary>
        <nav aria-label="Mobile navigation"><NavigationLinks /></nav>
      </details>
    </header>

    <main id="main">
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <h1 id="hero-title">Catch the slow drain before it becomes a clog.</h1>
          <p>Company Name times how fast every drain empties, learns what normal looks like, and tells you the moment one starts to slow.</p>
          <div className={styles.actions}>
            <a href="/" className={styles.primary}>Book a demo</a>
            <a href="/" className={styles.secondary}>Watch the test rig</a>
          </div>
        </div>
        <div className={styles.heroVisual}>
          <div className={styles.heroCanvas}>
            <img className={styles.pipe} src={`${artwork}pipe-and-drip.png`} width="620" height="660" alt="A pipe dripping into water" />
            <div className={styles.alert} aria-label="Illustrative slow-drain alert">
              <div className={styles.alertTop}><span className={styles.tag}>Slow drain</span><span>just now</span></div>
              <p className={styles.fixtureName}>Floor drain 3</p>
              <p className={styles.fixtureId}>DR-4824</p>
              <div className={styles.alertValue}><strong>44</strong><span>s</span><img src={`${artwork}sparkline.png`} width="110" height="36" alt="" /></div>
              <p className={styles.baseline}>+20 s vs baseline</p>
            </div>
          </div>
        </div>
      </section>

      <WaterDivider />
      <section id="how-it-works" className={styles.howItWorks} aria-labelledby="how-title">
        <div className={styles.sectionHeading}>
          <h2 id="how-title">Spot the slowdown weeks before the clog.</h2>
          <p>Guests and residents adapt to a draining-slower sink until it stops working. Company Name notices the change they don’t.</p>
        </div>
        <div className={styles.steps}>
          {steps.map((step, index) => <article key={step.image} className={styles.step}>
            <div className={styles.stepIllustration}><img src={`${artwork}${step.image}`} width="360" height="190" alt="" /></div>
            <div className={styles.stepBody}>
              <h3><span className={styles.stepNumber}>{index + 1}</span>{step.title}</h3>
              <p>{index === 1 ? <>It adapts to each drain, including different starting water levels, so there are no false <br className={styles.designBreak} />alarms.</> : step.description}</p>
            </div>
          </article>)}
        </div>
      </section>

      <section id="for-hotels" className={styles.hotels} aria-labelledby="hotels-title">
        <div className={styles.hotelCopy}>
          <h2 id="hotels-title">Guests rarely report a slow drain. We do.</h2>
          <p>In a hotel nobody speaks up, so a failing drain is found at its worst, usually mid-stay. See every room’s drains on one screen and fix the worst ones first.</p>
          <a className={styles.secondary} href="/">See the building heat map</a>
        </div>
        <figure className={styles.heatMap}>
          <div className={styles.hotelIllustration}><img src={`${artwork}hotel.png`} width="560" height="390" alt="Illustrative hotel cutaway showing drainage status by room" /></div>
          <figcaption>Floor 3: 9 of 10 drains slowing. Likely a shared stack.</figcaption>
        </figure>
      </section>

      <WaterDivider />
      <section className={styles.cta} aria-labelledby="demo-title">
        <div className={styles.ctaPanel}>
          <div className={styles.ctaCopy}>
            <h2 id="demo-title">See it catch a clog before the guests do.</h2>
            <p>Our transparent test rig restricts a drain step by step. Watch Company Name recognize every stage.</p>
            <a className={styles.primary} href="/">Book a demo</a>
          </div>
          <div className={styles.dropletBackdrop}><img src={`${artwork}droplet.png`} width="220" height="270" alt="" /></div>
        </div>
      </section>
    </main>
    <footer className={styles.footer}>© 2026 Placeholder name.</footer>
  </div>;
}
