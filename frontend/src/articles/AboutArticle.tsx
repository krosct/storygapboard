import type { Meta } from '../api'

export default function AboutArticle({ meta }: { meta: Meta | null }) {
  const limits = meta?.limits
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
        <li>In <a href="#generate">Generate</a>, choose the layout and the ratio (the shape of each panel), and drop your
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
    </>
  )
}
