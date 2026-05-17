interface Props {
  twitch?: string;
  youtube?: string;
  twitter?: string;
  discord?: string;
}

/**
 * Branded social handle row, used by the Ending scene.
 * Only renders pills for handles that were filled in.
 */
export function SocialRow({ twitch, youtube, twitter, discord }: Props) {
  const items: Array<{ svc: string; handle: string }> = [];
  if (twitch)  items.push({ svc: "Twitch",  handle: twitch });
  if (youtube) items.push({ svc: "YouTube", handle: youtube });
  if (twitter) items.push({ svc: "X",       handle: twitter });
  if (discord) items.push({ svc: "Discord", handle: discord });

  if (items.length === 0) return null;

  return (
    <div className="cs-social">
      {items.map((i) => (
        <div key={i.svc} className="cs-social-item">
          <span className="cs-social-svc">{i.svc}</span>
          <span>{i.handle}</span>
        </div>
      ))}
    </div>
  );
}
