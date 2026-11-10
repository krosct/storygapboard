import { useState } from 'react'
import type { Meta } from '../api'
import ImageViewer from '../components/ImageViewer'
import Modal from '../components/Modal'

/** The visual guide: its two pages as images (see docs/how-it-works.html), plus the PDF to keep. */
const GUIDE_PAGES = ['/how-it-works/page-1.jpg', '/how-it-works/page-2.jpg']

export default function AboutArticle({ meta }: { meta: Meta | null }) {
  const limits = meta?.limits
  const [guideOpen, setGuideOpen] = useState(false)
  const [guidePage, setGuidePage] = useState(0)
  // 0 = no limit (server setting): say nothing about it
  const caps = [
    limits && limits.generate_per_minute > 0 ? `${limits.generate_per_minute} per minute` : '',
    limits && limits.generate_per_day > 0 ? `${limits.generate_per_day} per day` : '',
  ].filter(Boolean)
  return (
    <>
      <p>StoryGapBoard turns a few images of your own, plus an optional story, notes and reference images, into a
        complete storyboard: one image with a grid of panels (you pick the layout, e.g. 2x3 = 2 rows and 3 columns, and
        the shape of each panel), using the image model of your choice on OpenRouter or OpenAI. Then you can retouch
        any detail of any panel.</p>
      <h3>How it works</h3>
      <ol>
        <li>In <a href="#model">Model</a>, pick the provider (OpenRouter or OpenAI), set your key for it and, if you like,
          a model. Pick one that accepts images as input.</li>
        <li>Optionally attach notes or reference images in <a href="#files">Files</a>.</li>
        <li>In <a href="#fill">Fill</a>, choose the layout and the ratio (the shape of each panel), and drop your
          own images in some panels. They go into the storyboard exactly as shown: drag an image to choose its framing.
          The model draws the empty panels.</li>
        <li>Writing the story is optional: leave it empty and the model completes it from your panels, or add what you
          want to happen.</li>
        <li>In the result, drag any panel to move its framing, or download a single panel with its arrow button.</li>
        <li>Not happy with a detail? Use the pencil on its panel, paint over or circle it (in a color that stands out
          there) and say what to change. Choose how far the change may reach (only the marks, around them, or the whole
          panel): nothing else in the storyboard changes. Undo and redo retouches freely, then download the
          storyboard.</li>
      </ol>
      <p>
        <button type="button" className="guide-open" onClick={() => { setGuidePage(0); setGuideOpen(true) }}>
          <span className="icon solid fa-file-alt" aria-hidden="true"></span> Visual guide (2 pages)
        </button>
      </p>
      <h3>Privacy</h3>
      <ul>
        <li>Your API key, prompt, files and panels stay in this tab. Nothing is kept after you close it.</li>
        <li>Uploaded files and generated images are processed in memory and never saved on the server. A retouch sends
          only the panel being retouched.</li>
        <li>For abuse prevention the server keeps a log of generations and retouches (prompt, model, settings, cost and
          anonymised identifiers). Keys and IP addresses are never written in clear text.</li>
      </ul>
      <h3>Fair use</h3>
      <p>To keep the service healthy, each visitor can run one generation or retouch at a time
        {caps.length > 0 ? `, up to ${caps.join(' and ')}` : ''}
        {' '}(retouches count like generations).
        Repeated rejected API keys temporarily block new generations from the same connection.</p>
      <p className="hint">Design: <a href="https://html5up.net" target="_blank" rel="noopener noreferrer">HTML5 UP</a> (Dimension).
        Icons: Font Awesome.</p>

      {guideOpen && (
        <Modal title="Visual guide" busy={false} onClose={() => setGuideOpen(false)} className="guide-modal">
          {/* keyed by the page: each page starts fitted to the window */}
          <ImageViewer key={GUIDE_PAGES[guidePage]} src={GUIDE_PAGES[guidePage]}
            alt={`Visual guide, page ${guidePage + 1} of ${GUIDE_PAGES.length}`} width={1240} height={1754} />
          <div className="guide-nav">
            <button type="button" className="icon-only icon solid fa-chevron-left" aria-label="Previous page"
              title="Previous page" disabled={guidePage === 0} onClick={() => setGuidePage((p) => p - 1)} />
            <span className="guide-count">{guidePage + 1} / {GUIDE_PAGES.length}</span>
            <button type="button" className="icon-only icon solid fa-chevron-right" aria-label="Next page"
              title="Next page" disabled={guidePage === GUIDE_PAGES.length - 1}
              onClick={() => setGuidePage((p) => p + 1)} />
            <a className="guide-pdf" href="/how-it-works.pdf" target="_blank" rel="noopener noreferrer"
              title="Open the PDF">
              <span className="icon solid fa-file-pdf" aria-hidden="true"></span> PDF
            </a>
          </div>
        </Modal>
      )}
    </>
  )
}
