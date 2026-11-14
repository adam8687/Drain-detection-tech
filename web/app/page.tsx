import type { Metadata } from 'next';
import styles from './page.module.css';
import ProductHeader from '../components/product-header';
import DesignAsset from '../components/design-asset';

const artwork = '/images/design/';

export const metadata: Metadata = {
  title: 'Smart Housing',
  description: 'Catch the slow drain before it becomes a clog.',
};

const steps = [
  { image: '453bd.svg', title: 'A sensor times every drain', description: 'A removable water-level sensor measures how quickly water recedes after each use.' },
  { image: '6e7d6.svg', title: 'Software learns what’s normal', description: 'A quick empty-sink check establishes the reference. Usual drain times are learned during normal use.' },
  { image: '2646e.svg', title: 'You get the early warning', description: 'Persistent slowing is flagged while it’s still a nuisance, not an emergency.' },
];

function HomeWaves({section}:{section:'hero'|'steps'|'hotel'|'footer'}) {
 const slots={hero:[['96424.svg',964.51,-56.74],['75a5b.svg',488.76,416.94],['93eeb.svg',272.35,531.74],['8c3ad.svg',-50,613]],steps:[['2a790.svg',-107.1,490.14],['ff20c.svg',-92.09,558.58]],hotel:[['cf0fe.svg',-93.62,419.21],['94b40.svg',-86.41,491.67]],footer:[['e38ab.svg',-148,12]]} as const;
 return <div className={styles.decor} aria-hidden="true">{slots[section].map(([file,left,top])=><div key={file} style={{left,top}}><DesignAsset file={file}/></div>)}</div>;
}
export default function Home() {
  return <div className={styles.page}>
    <a href="#main" className={styles.skipLink}>Skip to content</a>
    <ProductHeader marketing />

    <main id="main">
      <section className={styles.hero} aria-labelledby="hero-title">
        <HomeWaves section="hero" />
        <div className={styles.bubbles} aria-hidden="true">{[['6f715.svg',120,86],['0ed2c.svg',70,118],['0aea6.svg',1210,640],['dc225.svg',566,150],['3e6eb.svg',610,96],['1bd46.svg',122,88],['2e028.svg',73.6,121.6],['0b027.svg',1216,646],['a19d7.svg',568.8,152.8],['c3496.svg',615.2,101.2]].map(([file,left,top])=><div key={String(file)} style={{left:Number(left),top:Number(top)}}><DesignAsset file={file as '6f715.svg'}/></div>)}</div>
        <div className={styles.heroCopy}>
          <h1 id="hero-title">Catch the slow drain before it becomes a clog.</h1>
          <p>Synk times how fast every drain empties, learns what normal looks like, and tells you the moment one starts to slow.</p>
          <div className={styles.actions}>
            <a href="#demo" className={styles.primary}>Book a demo</a>
            <a href="/live-demo" className={styles.secondary}>Watch the test rig</a>
          </div>
        </div>
        <div className={styles.heroVisual}>
          <div className={styles.heroCanvas}>
            <DesignAsset className={styles.pipe} file="8f4ff.svg" alt="Layered blue basin with water ripples and a connected sensor" />
            <div className={styles.alert} aria-label="Illustrative slow-drain alert">
              <div className={styles.alertTop}><span className={styles.tag}>Slow drain</span><span>just now</span></div>
              <p className={styles.fixtureName}>Room 108, Sink 1</p>
              <p className={styles.fixtureId}>DR-4824</p>
              <div className={styles.alertValue}><strong>44</strong><span>s</span><DesignAsset file="d358c.svg"/></div>
              <p className={styles.baseline}>+20 s vs usual time</p>
            </div>
          </div>
        </div>
      </section>

      <section id="how-it-works" className={styles.howItWorks} aria-labelledby="how-title">
        <HomeWaves section="steps" /><div className={styles.sectionHeading}>
          <h2 id="how-title">Spot the slowdown weeks before the clog.</h2>
          <p>Guests and residents adapt to a draining-slower sink until it stops working. Synk notices the change they don’t.</p>
        </div>
        <div className={styles.steps}>
          {steps.map((step, index) => <article key={step.image} className={styles.step}>
            <div className={styles.stepIllustration}><DesignAsset file={step.image as '453bd.svg'} /></div>
            <div className={styles.stepBody}>
              <h3><span className={styles.stepNumber}>{index + 1}</span>{step.title}</h3>
              <p>{step.description}</p>
            </div>
          </article>)}
        </div>
      </section>

      <section id="for-hotels" className={styles.hotels} aria-labelledby="hotels-title">
        <div className={styles.sectionWave} aria-hidden="true"><DesignAsset file="78301.svg"/></div><HomeWaves section="hotel" /><div className={styles.hotelCopy}>
          <h2 id="hotels-title">Guests rarely report a slow drain. We do.</h2>
          <p>In a hotel nobody speaks up, so a failing drain is found at its worst, usually mid-stay. See every room’s drains on one screen and fix the worst ones first.</p>
          <a className={styles.secondary} href="/heat-map">See the building heat map</a>
        </div>
        <figure className={styles.heatMap}>
          <div className={styles.hotelIllustration}><DesignAsset file="86908.svg" alt="Illustrative hotel cutaway showing drainage status by room"/></div>
          <figcaption>Floor 3: 9 of 10 drains slowing. Likely a shared stack.</figcaption>
        </figure>
      </section>

      <section id="demo" className={styles.cta} aria-labelledby="demo-title">
        <div className={styles.ctaPanel}>
          <div className={styles.ctaCopy}>
            <h2 id="demo-title">See it catch a clog before the guests do.</h2>
            <p>Our transparent test rig restricts a drain step by step. Watch Synk recognize every stage.</p>
            <a className={styles.primary} href="/add-unit">Get started</a>
          </div>
          <div className={styles.dropletBackdrop}><DesignAsset file="d206a.svg"/></div>
        </div>
      </section>
    </main>
    <footer className={styles.footer}><HomeWaves section="footer"/><span>© 2026 Synk.</span></footer>
  </div>;
}
