// ─────────────────────────────────────────────────────────────────────────────
// Email System — BeeyGO Company Standard
// All templates: table-based layout, fully inline CSS, Outlook-safe.
// ─────────────────────────────────────────────────────────────────────────────

const CY = new Date().getFullYear();

// Brand colors (solid — rgba is unreliable in many email clients)
const C = {
  bg: '#04080f',
  card: '#0b1628',
  cardBdr: '#1c3050',
  header: '#061220',
  cyan: '#00e5ff',
  cyanDim: '#0097b2',
  cyanBg: '#061e2a',
  cyanBdr: '#0d4060',
  green: '#22c55e',
  greenBg: '#071a0f',
  greenBdr: '#14532d',
  red: '#f87171',
  redBg: '#1a0707',
  redBdr: '#7f1d1d',
  gold: '#f5b800',
  goldBg: '#1a1200',
  goldBdr: '#78530a',
  text: '#d4e8f0',
  muted: '#7a9ab0',
  dim: '#3d5a72',
  white: '#ffffff',
};

// ── Shared reusable blocks ────────────────────────────────────────────────────

const emailWrap = (innerHtml) => `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <title>BeeyGO</title>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};font-family:'Segoe UI',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <!-- Preview text (hidden) -->
  <div style="display:none;font-size:1px;color:${C.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">BeeyGO Ambassador Programme</div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.bg};">
    <tr>
      <td align="center" style="padding:40px 16px 60px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">
          ${innerHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const emailHeader = () => `
<tr>
  <td style="background-color:${C.header};border-radius:16px 16px 0 0;border:1px solid ${C.cardBdr};border-bottom:none;padding:28px 40px;" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center">
          <div style="display:inline-block;background:linear-gradient(135deg,#4df4ff,#0097b2);border-radius:12px;padding:10px 24px;margin-bottom:10px;">
            <span style="font-size:22px;font-weight:900;color:#04080f;letter-spacing:3px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">BYGO</span>
          </div>
          <br/>
          <span style="font-size:11px;color:${C.muted};letter-spacing:2px;text-transform:uppercase;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">BeeyGO · BEP-20 · Binance Smart Chain</span>
        </td>
      </tr>
    </table>
  </td>
</tr>`;

const divider = (color = C.cyanBdr) => `
<tr>
  <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:0 40px;">
    <div style="height:1px;background-color:${color};"></div>
  </td>
</tr>`;

const sectionLabel = (text, color = C.cyan) => `
<p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${color};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${text}</p>`;

const infoRow = (key, val, valColor = C.white, last = false) => `
<tr>
  <td style="color:${C.muted};font-size:13px;padding:8px 0;border-bottom:${last ? 'none' : `1px solid ${C.dim}`};width:40%;font-family:'Segoe UI',Helvetica,Arial,sans-serif;vertical-align:top;">${key}</td>
  <td style="color:${valColor};font-size:13px;padding:8px 0;border-bottom:${last ? 'none' : `1px solid ${C.dim}`};font-weight:600;font-family:'Segoe UI',Helvetica,Arial,sans-serif;vertical-align:top;">${val}</td>
</tr>`;

const ctaButton = (text, url, bg = C.cyan, textColor = C.bg) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
  <tr>
    <td style="border-radius:50px;background-color:${bg};">
      <a href="${url}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:700;color:${textColor};text-decoration:none;font-family:'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:0.5px;border-radius:50px;">${text}</a>
    </td>
  </tr>
</table>`;

const bannerBlock = (bg, border, icon, title, desc, titleColor = C.white) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td style="background-color:${bg};border:1px solid ${border};border-radius:12px;padding:20px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td width="40" style="vertical-align:top;padding-right:14px;font-size:26px;">${icon}</td>
          <td>
            <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${titleColor};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${title}</p>
            <p style="margin:0;font-size:13px;color:${C.text};line-height:1.6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${desc}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

const stepRow = (icon, title, desc) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:14px;">
  <tr>
    <td width="44" style="vertical-align:top;padding-right:14px;">
      <div style="width:36px;height:36px;background-color:${C.cyanBg};border:1px solid ${C.cyanBdr};border-radius:10px;text-align:center;line-height:36px;font-size:18px;">${icon}</div>
    </td>
    <td style="vertical-align:top;padding-top:4px;">
      <p style="margin:0 0 2px;font-size:14px;font-weight:700;color:${C.white};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${title}</p>
      <p style="margin:0;font-size:13px;color:${C.muted};line-height:1.5;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${desc}</p>
    </td>
  </tr>
</table>`;

const emailFooter = () => `
<tr>
  <td style="background-color:${C.header};border-radius:0 0 16px 16px;border:1px solid ${C.cardBdr};border-top:none;padding:28px 40px;" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center" style="padding-bottom:16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 8px;">
                <a href="https://t.me/BeeyGOs" target="_blank" style="color:${C.cyan};font-size:12px;text-decoration:none;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Telegram</a>
              </td>
              <td style="color:${C.dim};font-size:12px;">·</td>
              <td style="padding:0 8px;">
                <a href="https://x.com/Official_BeeyGO" target="_blank" style="color:${C.cyan};font-size:12px;text-decoration:none;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Twitter / X</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td align="center">
          <p style="margin:0 0 4px;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">© ${CY} BeeyGO. All rights reserved.</p>
          <p style="margin:0;font-size:11px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">$BYGO Token · BEP-20 · Binance Smart Chain</p>
          <p style="margin:8px 0 0;font-size:11px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">You received this email because you applied to the BeeyGO Ambassador Programme.</p>
        </td>
      </tr>
    </table>
  </td>
</tr>`;

exports.confirmationEmail = (data) => emailWrap(`
  ${emailHeader()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:40px 40px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <div style="display:inline-block;background-color:${C.cyanBg};border:1px solid ${C.cyanBdr};border-radius:50%;width:64px;height:64px;line-height:64px;text-align:center;font-size:30px;">✅</div>
          </td>
        </tr>
        <tr>
          <td align="center">
            <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:${C.cyan};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Application Received!</h1>
            <p style="margin:0 0 24px;font-size:15px;color:${C.text};line-height:1.7;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
              Hey <strong style="color:${C.white};">${data.firstName}</strong>, thank you for applying to become a
              <strong style="color:${C.cyan};">BeeyGO Ambassador</strong>.<br/>
              We've received your application and our team will review it within
              <strong style="color:${C.white};">3–5 business days</strong>.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;">
      ${sectionLabel('Application Summary')}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${infoRow('Full Name', `${data.firstName} ${data.lastName}`)}
        ${infoRow('Email', data.email, C.cyan)}
        ${infoRow('Country', data.country)}
        ${infoRow('Telegram', `@${data.telegram}`)}
        ${infoRow('Twitter / X', `@${data.twitter}`)}
        ${infoRow('Channel Handle', `@${data.channelHandle}`)}
        ${infoRow('Follower Range', data.followerCount, C.cyan)}
        ${infoRow('Content Niche', data.niche, C.text, true)}
      </table>
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;">
      ${sectionLabel('What Happens Next')}
      ${stepRow('📋', 'Review', 'Our team carefully reviews every application within 3–5 business days.')}
      ${stepRow('📧', 'Decision', 'You will receive an email at <strong>${data.email}</strong> with the outcome.')}
      ${stepRow('🚀', 'Onboarding', 'Approved ambassadors receive a welcome kit, referral link, and their first $BYGO allocation.')}
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;" align="center">
      <p style="margin:0 0 20px;font-size:14px;color:${C.muted};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        While you wait, join our community and stay updated on $BYGO.
      </p>
      ${ctaButton('📣  Join BeeyGO Telegram', 'https://t.me/BeeyGOs')}
      <p style="margin:16px 0 0;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Questions? Reply to this email or message us on Telegram.
      </p>
    </td>
  </tr>
  ${emailFooter()}
`);

exports.approvalEmail = (data) => emailWrap(`
  ${emailHeader()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:40px 40px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <div style="display:inline-block;background-color:${C.greenBg};border:1px solid ${C.greenBdr};border-radius:50%;width:72px;height:72px;line-height:72px;text-align:center;font-size:36px;">🎉</div>
          </td>
        </tr>
        <tr>
          <td align="center">
            <h1 style="margin:0 0 8px;font-size:28px;font-weight:800;color:${C.green};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">You're Approved!</h1>
            <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:${C.white};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Welcome to the official BeeyGO Ambassador Team</p>
            <p style="margin:0 0 28px;font-size:15px;color:${C.text};line-height:1.7;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
              Hey <strong style="color:${C.white};">${data.first_name}</strong>, your application has been
              <strong style="color:${C.green};">approved</strong>! You are now an official
              <strong style="color:${C.cyan};">BeeyGO Ambassador</strong>. We're thrilled to have you on the team.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  ${divider(C.greenBdr)}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:0 40px 32px;">
      ${bannerBlock(C.greenBg, C.greenBdr, '🏅', 'Official Ambassador Status Granted', `Your ambassador badge will be issued across all BeeyGO platforms. You now have access to exclusive resources, early announcements, and the private ambassador community.`, C.green)}
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;">
      ${sectionLabel('Your Next Steps', C.green)}
      ${stepRow('📦', 'Onboarding Kit', 'Our team will reach out within 24–48 hours with your full ambassador kit, brand assets, and posting guidelines.')}
      ${stepRow('🔗', 'Referral Link', 'You will receive your unique $BYGO referral link to start earning bonuses for every new user you bring in.')}
      ${stepRow('💰', '$BYGO Allocation', 'Your first monthly $BYGO token allocation will be processed and sent to your registered wallet.')}
      ${stepRow('👥', 'Private Community', 'You will be added to the exclusive Ambassador Hub on Telegram, where you can coordinate with the team and fellow ambassadors globally.')}
    </td>
  </tr>
  ${divider()}
  ${data.admin_notes ? `
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:0 40px 32px;">
      ${bannerBlock(C.cyanBg, C.cyanBdr, '📝', 'Note from the BeeyGO Team', data.admin_notes, C.cyan)}
    </td>
  </tr>
  ${divider()}` : ''}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;" align="center">
      <p style="margin:0 0 20px;font-size:14px;color:${C.text};font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;">
        Join the exclusive Ambassador Hub now to meet the team:
      </p>
      ${ctaButton('🚀  Join Ambassador Hub', 'https://t.me/+HcnnNcqBh2VjMmU0', C.green, C.bg)}
      <p style="margin:14px 0 0;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Questions? Reply to this email or reach us on Telegram.
      </p>
    </td>
  </tr>
  ${emailFooter()}
`);

exports.rejectionEmail = (data) => emailWrap(`
  ${emailHeader()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:40px 40px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <div style="display:inline-block;background-color:${C.cyanBg};border:1px solid ${C.cyanBdr};border-radius:50%;width:64px;height:64px;line-height:64px;text-align:center;font-size:30px;">📩</div>
          </td>
        </tr>
        <tr>
          <td align="center">
            <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:${C.white};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Application Update</h1>
            <p style="margin:0 0 24px;font-size:15px;color:${C.text};line-height:1.7;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
              Hey <strong style="color:${C.white};">${data.first_name}</strong>, thank you for taking the time to apply
              to the <strong style="color:${C.cyan};">BeeyGO Ambassador Programme</strong>.<br/><br/>
              After a careful review of your application, we are unable to move forward at this time. This decision is
              not a reflection of your overall potential, and we appreciate the effort you put into your application.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  ${divider()}
  ${data.admin_notes ? `
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:0 40px 32px;">
      ${bannerBlock(C.cyanBg, C.cyanBdr, '💬', 'Feedback from the Team', data.admin_notes, C.cyan)}
    </td>
  </tr>
  ${divider()}` : ''}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;">
      ${sectionLabel('Keep Growing With $BYGO')}
      ${stepRow('🌱', 'Grow Your Community', 'Continue building your audience and community presence. We look for passionate, engaged creators of all sizes.')}
      ${stepRow('📅', 'Reapply in the Future', 'Applications are reviewed on a rolling basis. You are welcome to reapply once you have expanded your community reach.')}
      ${stepRow('⚡', 'Stay in the Ecosystem', 'Join the BeeyGO Telegram Mini-App to mine $BYGO daily and stay engaged with the community while you grow.')}
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;" align="center">
      <p style="margin:0 0 20px;font-size:14px;color:${C.text};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Stay connected with the $BYGO community on Telegram:
      </p>
      ${ctaButton('💬  Join BeeyGO Community', 'https://t.me/BeeyGOs')}
      <p style="margin:14px 0 0;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Questions? Reply to this email or reach us on Telegram.
      </p>
    </td>
  </tr>
  ${emailFooter()}
`);

exports.adminNotificationEmail = (data) => {
  const submittedAt = new Date().toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });
  return emailWrap(`
  <tr>
    <td style="background-color:#080f1a;border:1px solid #1c3050;border-radius:16px 16px 0 0;border-bottom:none;padding:24px 40px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="center">
            <div style="display:inline-block;background:linear-gradient(135deg,#4df4ff,#0097b2);border-radius:10px;padding:8px 20px;margin-bottom:8px;">
              <span style="font-size:18px;font-weight:900;color:#04080f;letter-spacing:3px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">BYGO ADMIN</span>
            </div>
            <br/>
            <span style="font-size:11px;color:${C.muted};letter-spacing:2px;text-transform:uppercase;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ambassador Programme · Internal Notification</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:28px 40px 0;">
      ${bannerBlock(C.cyanBg, C.cyanBdr, '🆕', 'New Ambassador Application Received', `Submitted: <strong style="color:${C.white};">${submittedAt} UTC</strong> &nbsp;·&nbsp; Immediate review recommended`, C.cyan)}
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px 24px;">
      ${sectionLabel('Personal Information')}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${infoRow('Full Name', `${data.firstName} ${data.lastName}`, C.white)}
        ${infoRow('Email', `<a href="mailto:${data.email}" style="color:${C.cyan};text-decoration:none;">${data.email}</a>`, C.cyan)}
        ${infoRow('Country', data.country)}
        ${infoRow('Telegram', `@${data.telegram}`, C.white, true)}
      </table>
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px 24px;">
      ${sectionLabel('Social Presence')}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${infoRow('Twitter / X', `<a href="https://twitter.com/${data.twitter}" style="color:${C.cyan};text-decoration:none;">@${data.twitter}</a>`, C.cyan)}
        ${infoRow('Channel Handle', `<a href="https://t.me/${data.channelHandle}" style="color:${C.cyan};text-decoration:none;">@${data.channelHandle}</a>`, C.cyan)}
        ${infoRow('User Handle', `<a href="https://t.me/${data.userHandle}" style="color:${C.cyan};text-decoration:none;">@${data.userHandle}</a>`, C.cyan)}
        ${infoRow('Other Platform', data.socialUrl ? `<a href="${data.socialUrl}" style="color:${C.cyan};text-decoration:none;">${data.socialUrl}</a>` : '—', data.socialUrl ? C.cyan : C.dim)}
        ${infoRow('Follower Range', data.followerCount, C.gold)}
        ${infoRow('Content Niche', data.niche, C.white, true)}
      </table>
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px 24px;">
      ${sectionLabel('Why They Want to Be an Ambassador')}
      <p style="margin:0;font-size:14px;color:${C.text};line-height:1.75;white-space:pre-line;font-family:'Segoe UI',Helvetica,Arial,sans-serif;background-color:#070f1c;border-left:3px solid ${C.cyanBdr};padding:16px 20px;border-radius:0 8px 8px 0;">${data.motivation}</p>
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px 24px;">
      ${sectionLabel('How They Plan to Promote $BYGO')}
      <p style="margin:0;font-size:14px;color:${C.text};line-height:1.75;white-space:pre-line;font-family:'Segoe UI',Helvetica,Arial,sans-serif;background-color:#070f1c;border-left:3px solid ${C.cyanBdr};padding:16px 20px;border-radius:0 8px 8px 0;">${data.promotionPlan}</p>
    </td>
  </tr>
  ${divider()}
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;" align="center">
      <p style="margin:0 0 20px;font-size:14px;color:${C.text};font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;">
        Review and action this application in the admin panel:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
        <tr>
          <td style="padding-right:12px;">
            ${ctaButton('✅  Review Application', `${process.env.ADMIN_URL || 'https://beeygo-admin-three.vercel.app'}/applications`, C.cyan, C.bg)}
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Reply-To is set to <strong>${data.email}</strong> — you can reply directly to this email to contact the applicant.
      </p>
    </td>
  </tr>
  <tr>
    <td style="background-color:#080f1a;border:1px solid #1c3050;border-radius:0 0 16px 16px;border-top:none;padding:20px 40px;" align="center">
      <p style="margin:0 0 4px;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">BeeyGO Admin System · Ambassador Programme · Internal Use Only</p>
      <p style="margin:0;font-size:11px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">© ${CY} BeeyGO. $BYGO Token · BEP-20 · Binance Smart Chain</p>
    </td>
  </tr>
`);
};
