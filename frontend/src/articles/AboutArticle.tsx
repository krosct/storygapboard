import type { Meta } from '../api'

export default function AboutArticle({ meta }: { meta: Meta | null }) {
  const limits = meta?.limits
  return (
    <>
      <p>StoryGapBoard turns a short story, plus optional text notes and reference images, into a storyboard: one
        AI-generated image with a grid of panels (you pick the layout, e.g. 2x3 = 2 rows and 3 columns), using the
        image model of your choice on OpenRouter.</p>
      <h3>How it works</h3>
      <ol>
        <li>Set your OpenRouter key and, if you like, a model in <a href="#model">Model</a>.</li>
        <li>Optionally attach notes or reference images in <a href="#files">Files</a>.</li>
        <li>Write the story and choose a layout in <a href="#generate">Generate</a>, then download the storyboard.</li>
      </ol>
      <h3>Privacy</h3>
      <ul>
        <li>Your API key, prompt and files stay in this tab. Nothing is kept after you close it.</li>
        <li>Uploaded files and generated images are processed in memory and never saved on the server.</li>
        <li>For abuse prevention the server keeps a log of generations (prompt, model, settings, cost and
          anonymised identifiers). Keys and IP addresses are never written in clear text.</li>
      </ul>
      <h3>Fair use</h3>
      <p>To keep the service healthy, each visitor can run one generation at a time
        {limits ? `, up to ${limits.generate_per_minute} per minute and ${limits.generate_per_day} per day` : ''}.
        Repeated rejected API keys temporarily block new generations from the same connection.</p>
      <p className="hint">Design: <a href="https://html5up.net" target="_blank" rel="noopener noreferrer">HTML5 UP</a> (Dimension).
        Icons: Font Awesome.</p>
    </>
  )
}
