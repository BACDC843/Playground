#!/usr/bin/env python3
"""Builds the shareable Dotloop + Claude setup guide PDF."""

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    KeepTogether, ListFlowable, ListItem,
)

OUT = "/home/user/Playground/dotloop.plugin/docs/Dotloop-Claude-Setup-Guide.pdf"

NAVY = colors.HexColor("#1B2A41")
SLATE = colors.HexColor("#42566B")
ACCENT = colors.HexColor("#B07D48")
LIGHT = colors.HexColor("#F4F1EC")
BORDER = colors.HexColor("#D8D2C8")
WARN_BG = colors.HexColor("#FDF6E7")
WARN_BD = colors.HexColor("#D9A441")
BODY = colors.HexColor("#22303F")

ss = getSampleStyleSheet()


def style(name, **kw):
    base = kw.pop("parent", ss["Normal"])
    return ParagraphStyle(name, parent=base, **kw)


S = {
    "title": style("title", fontName="Helvetica-Bold", fontSize=25, leading=29,
                   textColor=NAVY, spaceAfter=6),
    "subtitle": style("subtitle", fontName="Helvetica", fontSize=12.5, leading=17,
                      textColor=SLATE, spaceAfter=18),
    "h1": style("h1", fontName="Helvetica-Bold", fontSize=15.5, leading=19,
                textColor=NAVY, spaceBefore=20, spaceAfter=9),
    "h2": style("h2", fontName="Helvetica-Bold", fontSize=11.8, leading=15,
                textColor=ACCENT, spaceBefore=13, spaceAfter=6),
    "body": style("body", fontName="Helvetica", fontSize=10.3, leading=15.4,
                  textColor=BODY, spaceAfter=8, alignment=TA_LEFT),
    "bullet": style("bullet", fontName="Helvetica", fontSize=10.3, leading=15,
                    textColor=BODY, spaceAfter=3),
    "callout": style("callout", fontName="Helvetica", fontSize=10.1, leading=15,
                     textColor=BODY),
    "callouthead": style("callouthead", fontName="Helvetica-Bold", fontSize=10.1,
                         leading=15, textColor=NAVY, spaceAfter=3),
    "code": style("code", fontName="Courier-Bold", fontSize=9.6, leading=14,
                  textColor=NAVY),
    "cell": style("cell", fontName="Helvetica", fontSize=9.5, leading=13,
                  textColor=BODY),
    "cellb": style("cellb", fontName="Helvetica-Bold", fontSize=9.5, leading=13,
                   textColor=NAVY),
    "cellh": style("cellh", fontName="Helvetica-Bold", fontSize=9.5, leading=13,
                   textColor=colors.white),
    "stepnum": style("stepnum", fontName="Helvetica-Bold", fontSize=15,
                     leading=18, textColor=colors.white),
    "steptitle": style("steptitle", fontName="Helvetica-Bold", fontSize=11.5,
                       leading=15, textColor=NAVY, spaceAfter=4),
    "foot": style("foot", fontName="Helvetica", fontSize=8, leading=10,
                  textColor=SLATE),
}


def para(t, s="body"):
    return Paragraph(t, S[s])


def bullets(items, style_key="bullet"):
    return ListFlowable(
        [ListItem(Paragraph(i, S[style_key]), leftIndent=14) for i in items],
        bulletType="bullet", bulletColor=ACCENT, bulletFontSize=7,
        leftIndent=13, spaceAfter=8,
    )


def callout(head, body_text, bg=LIGHT, bd=BORDER):
    inner = [para(head, "callouthead")] if head else []
    inner.append(para(body_text, "callout"))
    t = Table([[inner]], colWidths=[6.5 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.9, bd),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    return [Spacer(1, 4), t, Spacer(1, 10)]


def warn(head, body_text):
    return callout(head, body_text, bg=WARN_BG, bd=WARN_BD)


def code(line):
    t = Table([[Paragraph(line, S["code"])]], colWidths=[6.5 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EDEAE4")),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 11),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return [Spacer(1, 2), t, Spacer(1, 9)]


def step(n, title, flows):
    badge = Table([[Paragraph(str(n), S["stepnum"])]], colWidths=[0.42 * inch],
                  rowHeights=[0.42 * inch])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    content = [Paragraph(title, S["steptitle"])]
    for f in flows:
        content.extend(f if isinstance(f, list) else [f])
    t = Table([[badge, content]], colWidths=[0.62 * inch, 5.88 * inch])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    return KeepTogether(t)


def grid(headers, rows, widths):
    data = [[Paragraph(h, S["cellh"]) for h in headers]]
    for r in rows:
        data.append([Paragraph(r[0], S["cellb"])] +
                    [Paragraph(c, S["cell"]) for c in r[1:]])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.6, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return [Spacer(1, 3), t, Spacer(1, 12)]


def rule():
    t = Table([[""]], colWidths=[6.5 * inch], rowHeights=[2])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), ACCENT)]))
    return t


# ─── Page furniture ──────────────────────────────────────────────────────────

def decorate(canvas, doc):
    canvas.saveState()
    w, h = letter
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.6)
    canvas.line(1 * inch, 0.72 * inch, w - 1 * inch, 0.72 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE)
    canvas.drawString(1 * inch, 0.54 * inch, "Connecting Dotloop to Claude")
    canvas.drawRightString(w - 1 * inch, 0.54 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build():
    doc = BaseDocTemplate(
        OUT, pagesize=letter,
        leftMargin=1 * inch, rightMargin=1 * inch,
        topMargin=0.85 * inch, bottomMargin=0.95 * inch,
        title="Connecting Dotloop to Claude — Setup Guide",
        author="Barry Cunningham, The Boulevard Company",
        subject="Plain-English guide to connecting a Dotloop account to Claude",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=decorate)])

    st = []

    # ── Cover ───────────────────────────────────────────────────────────────
    st += [
        rule(), Spacer(1, 20),
        para("Connecting Dotloop to Claude", "title"),
        para("A plain-English guide for brokers, agents, and transaction coordinators",
             "subtitle"),
    ]

    st.append(callout(
        "The short version",
        "Dotloop already holds every detail of your transactions. This connection lets "
        "Claude read that information and answer questions about it in seconds &mdash; "
        "instead of you opening loop after loop to find a closing date.<br/><br/>"
        "For most agents, setup is a two-minute click-to-approve. Only one person at "
        "the brokerage does the technical part, and only once."
    ))

    st += [
        para("What it actually does", "h1"),
        para("Once connected, you can ask ordinary questions in plain English and get "
             "straight answers pulled from your live Dotloop data:"),
        bullets([
            "&ldquo;Which of my deals close in the next two weeks?&rdquo;",
            "&ldquo;What&rsquo;s the inspection deadline on the Meeting Street contract?&rdquo;",
            "&ldquo;Show me every loop under contract that&rsquo;s missing a lender.&rdquo;",
            "&ldquo;Which files still need a signed disclosure?&rdquo;",
            "&ldquo;Summarize where the Johnson transaction stands right now.&rdquo;",
        ]),
        para("It reads the same contract fields your loops already contain &mdash; purchase "
             "price, closing date, earnest money, commission, inspection and offer dates, "
             "participants, tasks, and documents. Nothing new has to be entered anywhere."),
    ]

    st.append(callout(
        "Why this is faster than opening the file",
        "Dotloop stores your contract terms as actual data fields, not just as a scanned "
        "PDF. That means Claude can check forty loops for a deadline in one pass, which is "
        "the kind of work that eats an afternoon by hand."
    ))

    # ── Who does what ───────────────────────────────────────────────────────
    st += [
        para("Who does what", "h1"),
        para("There are three roles. Most people are only the third one."),
        grid(
            ["Role", "What they do", "How long"],
            [
                ["Broker or owner",
                 "Approves the idea and signs off on Dotloop&rsquo;s API terms. Requests API "
                 "access from your Dotloop Partner Success Manager.",
                 "One email"],
                ["Setup person",
                 "Creates the Application Client inside Dotloop and installs the connector. "
                 "One person, one time, for the whole brokerage.",
                 "About an hour"],
                ["Individual agent",
                 "Clicks a link, logs into Dotloop, clicks Approve. That&rsquo;s the entire "
                 "job.",
                 "Two minutes"],
            ],
            [1.35 * inch, 3.75 * inch, 1.0 * inch],
        ),
    ]

    # ── Part 1: agents ──────────────────────────────────────────────────────
    st += [
        para("Part 1 &mdash; For agents", "h1"),
        para("If someone at your brokerage has already set this up, this is all you do."),
    ]

    st.append(step(1, "Get the connector address", [
        para("Your setup person gives you one web address. That is the only thing you "
             "need &mdash; there is nothing to download and nothing to install."),
    ]))
    st.append(step(2, "Add it in Claude", [
        para("In Claude Desktop or Cowork, open <b>Settings</b>, then <b>Connectors</b>, "
             "then <b>Add custom connector</b>. Paste the address and save."),
        para("If it asks for OAuth client details, leave those boxes empty."),
    ]))
    st.append(step(3, "Log into Dotloop and click Approve", [
        para("Claude sends you to Dotloop&rsquo;s own login page. Sign in with <b>your "
             "own</b> Dotloop account &mdash; the one holding your transactions &mdash; "
             "and click Approve."),
        para("<b>Tip:</b> if your browser is already signed into a different Dotloop "
             "account, sign out first or use a private window. Otherwise it may quietly "
             "connect the wrong account."),
        para("That is the whole job. You will not have to do it again."),
    ]))

    st.append(callout(
        "Nobody handles your password, including your setup person",
        "You type your Dotloop password on Dotloop&rsquo;s own site and nowhere else. Your "
        "setup person never sees it, and never sees the access key it creates for you."
    ))

    st.append(callout(
        "You can turn it off whenever you want",
        "Access is revocable from your own Dotloop account at any time, without anyone "
        "else&rsquo;s permission. Approving is not a one-way door."
    ))

    # ── Part 2: setup ───────────────────────────────────────────────────────
    st += [
        para("Part 2 &mdash; For the setup person", "h1"),
        para("This is the technical half. It happens once per brokerage, not once per "
             "agent. Some comfort with a command line helps, but there is no programming "
             "involved."),
    ]

    st.append(step(1, "Get API access turned on", [
        para("Ask your Dotloop Partner Success Manager for V2 API access. They will send "
             "a request form and approve the account. Expect a few days."),
    ]))
    st.append(step(2, "Create a dedicated Dotloop account", [
        para("Dotloop requires a separate account to hold the connection &mdash; something "
             "like <b>api@yourcompany.com</b>. A free account is fine."),
        para("Do not use a personal account. If that person leaves the company, the whole "
             "integration has to be rebuilt from scratch."),
    ]))
    st.append(step(3, "Create the Application Client", [
        para("Log into the new account, go to <b>My Account &gt; Clients</b>, and click "
             "<b>+ Add Client</b>. Fill in every field and save. Dotloop then shows you a "
             "<b>Client ID</b> and a <b>Secret</b>."),
    ]))

    st.append(warn(
        "The one step you cannot undo",
        "On that same screen is a section called <b>Access Control</b> with five switches: "
        "Account, Loop, Template, Profile, and Contact.<br/><br/>"
        "<b>Turn on all five.</b> Dotloop&rsquo;s own guide states these can be set only "
        "once &mdash; changing them later means building a brand new client and starting "
        "over. There is no downside to enabling everything up front.<br/><br/>"
        "Also: the Secret is displayed exactly one time. Copy it somewhere safe before you "
        "close that window."
    ))

    st.append(step(4, "Put the connector online", [
        para("Deploy the connector to a hosting service such as Railway, Render, or Fly. "
             "Give it your Client ID and Secret plus the public web address it will run "
             "at. The project README has the exact settings."),
        para("It has to be online rather than sitting on your desktop, because Claude on "
             "a phone or in a browser cannot reach a program running on your computer."),
    ]))
    st.append(step(5, "Register the return address", [
        para("Go back to your Dotloop Client and add this to its <b>Redirect URLs</b>:"),
        code("https://your-address/oauth/dotloop-callback"),
        para("Dotloop matches this exactly, and every agent login fails until it is "
             "registered. The connector prints the exact address when it starts up. "
             "Unlike Access Control, this field can be edited later."),
    ]))
    st.append(step(6, "Connect yourself first, then share", [
        para("Add the connector in your own Claude and walk through the Dotloop login. "
             "That proves the whole path works before anyone else touches it."),
        para("Then send the address to your agents. One address serves everyone &mdash; "
             "each person&rsquo;s own login is what decides whose loops they see."),
    ]))

    st.append(callout(
        "One setup serves the whole office",
        "You build the Dotloop client once. Every agent then connects themselves through "
        "it, and the connector keeps each agent&rsquo;s access separate. Adding someone "
        "later costs you nothing &mdash; you send them the same address."
    ))

    # ── Safety ──────────────────────────────────────────────────────────────
    st += [
        para("Security and privacy", "h1"),
        para("The questions a broker should ask, answered plainly."),
        grid(
            ["Question", "Answer"],
            [
                ["Where does our data go?",
                 "Nowhere new. The connection reads from Dotloop directly. There is no "
                 "middleman database and no copy of your transactions stored elsewhere."],
                ["Does it use our password?",
                 "No. Sign-in happens on Dotloop&rsquo;s own site using OAuth 2.0, the same "
                 "standard behind &lsquo;Sign in with Google.&rsquo; The connector never "
                 "sees or stores anyone&rsquo;s password."],
                ["Can it change our contracts?",
                 "Only if you allow it. It can be run strictly read-only. Where editing is "
                 "enabled, the assistant is instructed to state the exact change and get "
                 "confirmation first."],
                ["Who can see whose deals?",
                 "Each agent&rsquo;s approval covers only that agent&rsquo;s loops. "
                 "Approving does not expose one agent&rsquo;s transactions to another."],
                ["Can we shut it off?",
                 "Yes. Any agent can revoke their own access from Dotloop at any time. The "
                 "brokerage can disable the whole client, and Dotloop can revoke API access "
                 "at its own discretion."],
                ["Who holds the keys?",
                 "The connector does, on the server. Agents never see or handle a "
                 "credential, so there is nothing for them to paste, email, or lose. The "
                 "one secret a person handles is the brokerage&rsquo;s Client Secret, held "
                 "by the setup person alone."],
            ],
            [1.7 * inch, 4.4 * inch],
        ),
    ]

    # ── Dotloop rules ───────────────────────────────────────────────────────
    st += [
        para("What Dotloop requires", "h1"),
        para("Their rules, not ours. Worth knowing before you plan around this."),
        bullets([
            "<b>API access is approved case by case</b>, and Dotloop may discontinue it at "
            "their sole discretion.",
            "<b>A working demo is required</b> before the integration goes live.",
            "<b>Dotloop support does not help build it.</b> They answer questions about "
            "their endpoints, but only with a developer included on the thread.",
            "<b>There is a usage limit</b> of 100 requests per minute per user. Fine for "
            "daily work; large sweeps run in batches.",
        ]),
    ]

    st.append(warn(
        "If you plan to resell this",
        "Using this inside your own brokerage is one arrangement with Dotloop. Packaging "
        "and selling it to other brokerages is a different one &mdash; their request form "
        "scopes approval to a vendor or service provider of an existing Dotloop subscriber."
        "<br/><br/>"
        "Talk to your Partner Success Manager before you build a pricing page. It is a "
        "cheap conversation early and an expensive one late."
    ))

    # ── Close ───────────────────────────────────────────────────────────────
    st += [
        para("Honest limitations", "h1"),
        bullets([
            "<b>It reads what Dotloop has.</b> If a field was never filled in, the assistant "
            "cannot know it. Garbage in, nothing out.",
            "<b>It is not legal advice.</b> It surfaces dates, terms, and gaps. Interpreting "
            "what a clause obligates anyone to do remains your job.",
            "<b>Check before you act.</b> Treat it as a very fast assistant, not an "
            "unsupervised one. Verify anything consequential against the loop itself.",
        ]),
        Spacer(1, 8), rule(), Spacer(1, 14),
        para("Questions", "h2"),
        para("Barry Cunningham &mdash; The Boulevard Company<br/>"
             "<font color='#42566B'>Barry@TheBlvdCompany.com &nbsp;&middot;&nbsp; "
             "843.530.0755</font>"),
        Spacer(1, 10),
        para("Dotloop API documentation: dotloop.github.io/public-api<br/>"
             "Dotloop support: support.dotloop.com &nbsp;&middot;&nbsp; 888.368.5667",
             "foot"),
    ]

    flat = []
    for item in st:
        flat.extend(item if isinstance(item, list) else [item])
    doc.build(flat)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    build()
