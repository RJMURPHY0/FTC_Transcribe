import os

def ql(v):
    if v is None:
        return 'NULL'
    return "'" + str(v).replace("'", "''") + "'"

def ts(v):
    if v is None:
        return 'NULL'
    return "'" + str(v).replace("'", "''") + "+00'::timestamptz"

lines = []
lines.append("-- FTC Transcribe → FTC Contacts: full data migration")
lines.append("-- Run this in the FTC Contacts Supabase SQL editor")
lines.append("")

# ── Folder ────────────────────────────────────────────────────────────────────
lines.append("-- Folders")
lines.append("INSERT INTO \"Folder\" (id, name, \"createdAt\") VALUES ('cmo6wbtwc0000dukpzb6nslog', 'Meetings', '2026-04-20 07:51:22.905+00'::timestamptz) ON CONFLICT (id) DO NOTHING;")
lines.append("")

# ── Recordings ────────────────────────────────────────────────────────────────
recordings = [
    ("cmnsyimlz0000zva5ublgjgxj","test","2026-04-10 13:43:52.821",0,140621,"audio/webm;codecs=opus","","completed",None),
    ("cmnt17d2a00007bgipptwhcgo","Recording - 10 Apr 2026","2026-04-10 14:59:06.079",0,180157,"audio/webm;codecs=opus","","completed",None),
    ("cmnt1a2qp00057bgidl8z9hek","Recording - 10 Apr 2026","2026-04-10 15:01:12.585",0,171133,"audio/webm;codecs=opus","","completed",None),
    ("cmnt3as0y0000vqmjlb3d05go","Recording - 10 Apr 2026","2026-04-10 15:57:44.672",0,400813,"audio/webm;codecs=opus","","completed",None),
    ("cmnvz9qva0000tfe6ixo2dide","Recording - 12 Apr 2026","2026-04-12 16:28:16.579",0,1392817,"audio/webm;codecs=opus","","completed",None),
    ("cmo1ee8as0002473w0ubnya8m","Quality Assurance Testing Review - 16 Apr 2026","2026-04-16 11:30:30.474",0,0,"","","completed",None),
    ("cmo1fzjeg00001k2blbx5bhh0","System Testing and Transcription - 16 Apr 2026","2026-04-16 12:15:04.692",0,0,"","","completed",None),
    ("cmo1jhi4x0000j88b3grbw4z2","Testing and Planning Session - 16 Apr 2026","2026-04-16 13:53:01.711",0,0,"","","completed",None),
    ("cmo1jidee00008alostf1jmpn","Test System Verification - 16 Apr 2026","2026-04-16 13:53:42.228",0,0,"","","completed",None),
    ("cmo2zi8gt0000fb6ylhpkfb1o","Transcription Tool Demo - 17 Apr 2026","2026-04-17 14:09:15.866",0,0,"","","completed","cmo6wbtwc0000dukpzb6nslog"),
    ("cmo2zkdez0001fb6yx8ybervn","Meeting Notes Organization - 17 Apr 2026","2026-04-17 14:10:55.525",0,0,"","","completed","cmo6wbtwc0000dukpzb6nslog"),
    ("cmoa2rkvh0000wxozk5gw3968","Meeting Recording Setup - 22 Apr 2026","2026-04-22 13:14:53.93",0,0,"","","completed",None),
    ("cmocpbrrd0000wvqlpg9aubru","Musical Tool Demo - 24 Apr 2026","2026-04-24 09:21:59.878",0,0,"","","completed",None),
    ("cmog2eytg0000pg7vkyu6afy7","Meeting Recording Discussion - 26 Apr 2026","2026-04-26 17:51:42.53",0,0,"","","completed",None),
    ("cmoh8mt3c00006gtvp1wrgvgv","Meeting with Jason - app","2026-04-27 13:33:32.23",0,0,"","","completed","cmo6wbtwc0000dukpzb6nslog"),
    ("cmoipgdn9000014c8glq9oxrl","Software Development Demo - 28 Apr 2026","2026-04-28 14:12:11.923",0,0,"","","completed",None),
    ("cmp5e8z5v000088x6u8ij5bk0","meeting with Jason and Leigh Edgley","2026-05-14 11:17:12.833",0,0,"","","completed",None),
    ("cmpd9muv50000adegvk4xfkmz","Quarterly Results Presentation - 19 May 2026","2026-05-19 23:30:11.775",0,0,"","","completed",None),
    ("cmpmh44is0000m3pnqkx7p57m","Testing and Feedback Session - 26 May 2026","2026-05-26 10:09:30.338",0,0,"","","completed",None),
    ("cmpo5qyw60000eb8f0v9pzy0v","Unified Software Platform Discussion - 27 May 2026","2026-05-27 14:26:53.092",0,0,"","","completed",None),
    ("cmpo65j260001eb8ftxd313th","Meeting with Sean - Lead scraper - 27 May 2026","2026-05-27 14:38:11.984",0,0,"","","completed",None),
]

lines.append("-- Recordings")
for r in recordings:
    fid = "NULL" if r[8] is None else ql(r[8])
    lines.append(
        f'INSERT INTO "Recording" (id, title, "createdAt", duration, "fileSize", "mimeType", "audioPath", status, "folderId") '
        f'VALUES ({ql(r[0])}, {ql(r[1])}, {ts(r[2])}, {r[3]}, {r[4]}, {ql(r[5])}, {ql(r[6])}, {ql(r[7])}, {fid}) ON CONFLICT (id) DO NOTHING;'
    )
lines.append("")

# ── FinalizeJobs ──────────────────────────────────────────────────────────────
jobs = [
    ("cmp5ebsj50003frrre1lx514v","cmp5e8z5v000088x6u8ij5bk0","completed",2,"2026-05-14 11:19:24.209","2026-05-15 09:19:23.401"),
    ("cmpd9n1jl0004duy9ms992l1j","cmpd9muv50000adegvk4xfkmz","completed",1,"2026-05-19 23:30:20.433","2026-05-19 23:30:31.003"),
    ("cmo2zlm7q0003i64iu8lzg2sk","cmo2zkdez0001fb6yx8ybervn","completed",1,"2026-04-17 14:11:53.655","2026-04-17 14:12:07.823"),
    ("cmoiph65z0003j2bjgr3ipqkv","cmoipgdn9000014c8glq9oxrl","completed",1,"2026-04-28 14:12:48.888","2026-04-28 17:43:46.65"),
    ("cmpmh4gir0004z2h7z3mk4hwt","cmpmh44is0000m3pnqkx7p57m","completed",1,"2026-05-26 10:09:45.891","2026-05-26 10:09:55.307"),
    ("cmo2zl6bt000313y81t4pbnj3","cmo2zi8gt0000fb6ylhpkfb1o","completed",1,"2026-04-17 14:11:33.066","2026-04-17 14:33:43.801"),
    ("cmpo5rqik0004n2bkqanh8k2m","cmpo5qyw60000eb8f0v9pzy0v","completed",2,"2026-05-27 14:27:28.892","2026-05-27 14:38:18.649"),
    ("cmoh8qzwj000310k2w3hmxtnf","cmoh8mt3c00006gtvp1wrgvgv","completed",4,"2026-04-27 13:36:47.684","2026-04-28 10:28:24.368"),
    ("cmoa2sgld0003w9s4s404e5wt","cmoa2rkvh0000wxozk5gw3968","completed",1,"2026-04-22 13:15:35.041","2026-04-22 13:15:49.65"),
    ("cmocpcj0w0003qmyxa9qj310s","cmocpbrrd0000wvqlpg9aubru","completed",1,"2026-04-24 09:22:35.217","2026-04-24 09:22:46.619"),
    ("cmog2fk6b0003dcj0qhmwvj97","cmog2eytg0000pg7vkyu6afy7","completed",1,"2026-04-26 17:52:10.211","2026-04-26 17:52:21.714"),
    ("cmpo68ao7000in2bkg1kuijhd","cmpo65j260001eb8ftxd313th","completed",1,"2026-05-27 14:40:21.512","2026-05-27 15:20:01.717"),
]

lines.append("-- FinalizeJobs")
for j in jobs:
    lines.append(
        f'INSERT INTO "FinalizeJob" (id, "recordingId", status, attempts, "lockToken", "lockUntil", "lastError", "createdAt", "updatedAt") '
        f'VALUES ({ql(j[0])}, {ql(j[1])}, {ql(j[2])}, {j[3]}, NULL, NULL, \'\', {ts(j[4])}, {ts(j[5])}) ON CONFLICT (id) DO NOTHING;'
    )
lines.append("")

# ── Summaries ────────────────────────────────────────────────────────────────
summaries = [
    ("cmnsyioqo0004zva5yxvcs6yi","cmnsyimlz0000zva5ublgjgxj","This is a brief test meeting with no substantive content or discussion topics.","[]","[]","[]","[]","2026-04-10 13:43:55.584"),
    ("cmnt17fa900047bgigk46xus0","cmnt17d2a00007bgipptwhcgo","Brief discussion about transcription capabilities for training sessions and Teams meetings. The conversation appears to be introductory in nature with limited substantive content.","[\"Transcription functionality is available\",\"Can be used for training sessions\",\"Compatible with Teams meetings\"]","[]","[]","[]","2026-04-10 14:59:08.962"),
    ("cmnt1a5lo00097bginkp3runu","cmnt1a2qp00057bgidl8z9hek","The team discussed clarifying whether their product is a software application or a website, concluding that it is a website. This determination will guide how they communicate about the product going forward.","[\"Need to clarify product classification as software vs website\",\"Product is determined to be a website\",\"Classification impacts all future messaging and communication\"]","[]","[\"Product is classified as a website, not software\"]","[]","2026-04-10 15:01:16.381"),
    ("cmnt3b0gc0004vqmji37vpk9f","cmnt3as0y0000vqmjlb3d05go","The team discussed purchasing a microphone to enable automatic transcription of meetings. They noted that while current transcription capability exists, voice differentiation features will be available by Monday.","[\"Need to purchase a microphone for meeting transcription\",\"Transcription will automatically capture what is said\",\"Voice differentiation feature will be available by Monday\",\"Voice differentiation capability is considered important\"]","[\"Buy a microphone\"]","[\"Implement automatic transcription for meetings\"]","[]","2026-04-10 15:57:55.597"),
    ("cmnvz9y8t0004tfe60f6yqrch","cmnvz9qva0000tfe6ixo2dide","A discussion about testing a transcription tool that records meetings and automatically generates meeting notes. The speakers explore the tool capabilities and discuss business acquisition potential while identifying time constraints as a key limitation.","[\"Transcription tool automatically records meetings and generates meeting notes\",\"Time constraints and limited average day usage identified as primary bottleneck\",\"Tool is considered good and functional by speakers\",\"Business acquisition and scalability potential discussed\"]","[]","[]","[]","2026-04-12 16:28:26.141"),
    ("cmo1eegsn0003opapc0ghko7e","cmo1ee8as0002473w0ubnya8m","This transcript consists only of repeated test phrases and contains no substantive meeting content, discussion topics, or actionable items.","[]","[]","[]","[]","2026-04-16 11:30:41.927"),
    ("cmo1g0j900001bp467gl4lpd2","cmo1fzjeg00001k2blbx5bhh0","Warren conducted a test meeting to evaluate the transcription system functionality for longer meetings. The test aims to assess transcription accuracy, consistency, and performance metrics such as processing time and error rates.","[\"Testing transcription system for longer meeting\",\"Evaluating consistency and accuracy of transcription\",\"Assessing whether the system gets details right or wrong\",\"Measuring full audio transcription time\",\"Identifying potential system failures or issues\"]","[]","[]","[]","2026-04-16 12:15:51.156"),
    ("cmo1ji1jj0003fwwfkc19g234","cmo1jhi4x0000j88b3grbw4z2","A brief test transcript with minimal substantive content.","[]","[]","[]","[]","2026-04-16 13:53:26.864"),
    ("cmo1jipu80003fyv3u5hoykrp","cmo1jidee00008alostf1jmpn","A brief test conversation to verify system functionality. Participants confirmed that everything is working as expected.","[\"System functionality is being tested\",\"Confirmation that everything is working properly\"]","[]","[]","[]","2026-04-16 13:53:58.352"),
    ("cmo2zlwpj00078nlfaqy4yht1","cmo2zkdez0001fb6yx8ybervn","The discussion covers meeting transcript management and storage features, including action list generation over two-week periods and custom chatbots for each meeting. The team discusses implementation of a filing system using folders to organize meetings by date, participant, and type.","[\"Action lists can be generated automatically for the past two weeks\",\"Custom chatbot available for each meeting with full transcript searchable and editable\",\"Backend storage is handled by Supabase\",\"Filing system with folders has been recently added for organization\",\"Meetings are organized by sections (customers, breaks) with participant names and dates\"]","[]","[\"Filing system with folders was implemented for organizing meetings\"]","[{\"time\":0,\"title\":\"Action list and information collection\"},{\"time\":7,\"title\":\"Custom chatbot and transcript search\"},{\"time\":17,\"title\":\"Backend storage and filing system\"},{\"time\":40,\"title\":\"Meeting organization and folders\"}]","2026-04-17 14:12:07.256"),
    ("cmo30dnwb000rtxo7vwygrf09","cmo2zi8gt0000fb6ylhpkfb1o","A demonstration and discussion of two AI-powered transcription and dictation tools. The team explored features, competitive advantages, monetization strategies, and next steps for potential product development and market launch.","[\"Two transcription tools were demonstrated including a newer internal development with Alt-V hotkey\",\"The internal tool includes AI-powered features such as grammar fixing and formal/casual formatting\",\"Proposed business model includes freemium approach with ads for basic version and paid premium tier\",\"Key missing implementation: user authentication and multi-user access\",\"Discussion of market differentiation challenges and long-term software strategy\"]","[\"Send installation link to user via email\",\"Conduct competitive analysis between internal tool and WhisperFlow\",\"Develop user authentication and login system\",\"Schedule detailed follow-up meeting next week\",\"Have Ryan and Alan test the tool\",\"Research App Store/Play Store distribution requirements\"]","[\"Proceed with developing the internal transcription tool as a potential business product\",\"Consider launching as a freemium model\",\"Plan to explore App Store and Play Store distribution channels\"]","[{\"time\":0,\"title\":\"Testing Recording Feature\"},{\"time\":120,\"title\":\"Data Storage Discussion\"},{\"time\":202,\"title\":\"App Development Features\"},{\"time\":289,\"title\":\"Business Plans Strategy\"},{\"time\":378,\"title\":\"Monetization Ad Strategy\"},{\"time\":558,\"title\":\"AI Tool Comparison\"},{\"time\":741,\"title\":\"Data Security Infrastructure\"},{\"time\":995,\"title\":\"Team Structure Scaling\"}]","2026-04-17 14:33:42.203"),
    ("cmoa2srf80007b8v1lykdxx59","cmoa2rkvh0000wxozk5gw3968","The speaker discusses the process of recording meetings for legal purposes and explains how meeting transcripts can be stored and summarized.","[\"Meeting is being recorded for legal purposes\",\"Transcripts are automatically generated and stored from recordings\",\"Meeting summaries can be created from the transcript data\",\"Notes and meeting outcomes can be synthesized from the recording system\"]","[]","[]","[]","2026-04-22 13:15:49.076"),
    ("cmocpcrdf00077lp399xiaswj","cmocpbrrd0000wvqlpg9aubru","A brief discussion about a process involving receiving something, treating it well, and returning it. One participant references an unfamiliar musical tool.","[\"Process involves receiving, treating well, and returning items\",\"Unfamiliar concept to at least one participant\",\"Musical tool was mentioned in conversation\"]","[]","[]","[]","2026-04-24 09:22:46.036"),
    ("cmog2fsls00079vjkckpfjs37","cmog2eytg0000pg7vkyu6afy7","The discussion centers on recording meetings and whether the system would display real-time information from captured network data.","[\"Meeting recording capability is a key feature being discussed\",\"Real-time information display from network-captured data is a requirement\",\"Current meeting length is acknowledged as insufficient for meaningful discussion\"]","[]","[]","[]","2026-04-26 17:52:21.137"),
    ("cmoihga1p00056uxf5z5loesq","cmoh8mt3c00006gtvp1wrgvgv","Meeting focused on developing an integrated software platform combining lead generation, CRM, transcription, and communication tools. The team demonstrated working prototypes and discussed plans for testing with select users before commercialization.","[\"WhisperFlow transcription tool needs microphone selection UI and background noise filtering\",\"Lead generation platform successfully scrapes company and contact data at very low cost\",\"Multi-feature integrated platform planned combining transcription, lead gen, CRM, and email outreach\",\"Selected test users identified: Laura, Fabrice, and high-level contact at major UK logistics company\",\"Product pricing strategy to undercut competitors while bundling features as add-ons\"]","[\"Add microphone selection button to WhisperFlow UI\",\"Switch from online API to offline LLM for transcription\",\"Prepare test versions for Laura, Fabrice, and logistics company executive\",\"Set up project tracking in Monday.com\",\"Research and compare CRM features from Salesforce, HubSpot, and Pipedrive\",\"Test lead generation tool with specific criteria\",\"Develop email outreach automation using LinkedIn API\",\"Finalize product name and create branding strategy\",\"Schedule follow-up meeting in 2 weeks\"]","[\"Combine all tools into single integrated platform\",\"Implement tiered pricing with optional add-ons\",\"Test with real-world users before launch\",\"Establish separate business entity for commercial software release\",\"Focus initial marketing efforts on single branded product name\"]","[{\"time\":0,\"title\":\"Phone settings and restrictions\"},{\"time\":192,\"title\":\"Joke sharing among team\"},{\"time\":360,\"title\":\"Employment termination discussion\"},{\"time\":442,\"title\":\"Drawing review and feedback\"},{\"time\":689,\"title\":\"Product testing and tweaks\"},{\"time\":1063,\"title\":\"Prospect list building process\"},{\"time\":2149,\"title\":\"Email database and tools\"},{\"time\":3014,\"title\":\"Product expansion and strategy\"}]","2026-04-28 10:28:10.333"),
    ("cmoix0gvj00015ku8gp01zxra","cmoipgdn9000014c8glq9oxrl","The speaker presented work on a software application they have been developing, consisting of one main application and additional add-on components.","[\"Three pieces of software have been created\",\"One main application that is functional\",\"Two additional software components function as add-ons\",\"Demonstration of the software was planned but interrupted\"]","[]","[]","[]","2026-04-28 17:43:46.542"),
    ("cmp6phaxo0003cs0u6oyl6jlb","cmp5e8z5v000088x6u8ij5bk0","A discussion between a sales team and a CRM tool developer about lead generation, data scraping practices, and a demonstration of a new CRM tool with AI-powered features.","[\"Current data scraping is outsourced to Matter costing approximately 40000 GBP\",\"SIC codes on Companies House are misleading so they scrape about us fields\",\"Company redacted around 20000 records where data provenance could not be proven\",\"Demonstrated CRM tool scrapes company data and finds individual contacts\",\"Tool includes ICP scoring to rate prospect fit\",\"AI-generated personalized outreach messages based on prospect research\",\"Built-in dialer with call recording transcription and automatic meeting note logging\"]","[\"Ensure GDPR compliance is robust before commercializing the data scraping feature\",\"Build out KPI aggregation suite for managers\",\"Develop quoting functionality\",\"Fix LinkedIn integration which is not yet working\",\"Complete the manager-level KPI dashboard functionality\",\"Explore extrapolating existing telematics customer data to find lookalike prospects\"]","[\"Continue using Matter for data scraping due to GDPR compliance assurance\",\"Maintain cautious GDPR approach by redacting records with unverified data sources\",\"Position the new CRM tool as a comprehensive HubSpot/Pipedrive competitor\",\"Focus tool development on reducing sales admin burden through automation\"]","[{\"time\":0,\"title\":\"Customer unsubscribe patterns\"},{\"time\":11,\"title\":\"Data scraping process via Matter\"},{\"time\":23,\"title\":\"Filtering criteria for target data\"},{\"time\":59,\"title\":\"Using existing customer data\"}]","2026-05-15 09:19:23.272"),
    ("cmpd9n99b0009r69r3r47pc9z","cmpd9muv50000adegvk4xfkmz","This appears to be a brief closing statement thanking viewers for watching. No substantive meeting content, discussion points, or decisions are present.","[]","[]","[]","[]","2026-05-19 23:30:30.431"),
    ("cmpmh4ncb0009futjpv7pd4q9","cmpmh44is0000m3pnqkx7p57m","This is a brief test transcript with minimal content. No substantive meeting discussion, decisions, or action items are present.","[]","[]","[]","[]","2026-05-26 10:09:54.731"),
    ("cmpo61ura0007nd7jm65ah1g4","cmpo5qyw60000eb8f0v9pzy0v","The team discussed a unified business software platform that consolidates multiple tools into one centralized location with integrated AI capabilities.","[\"Businesses currently use multiple disconnected software systems\",\"Proposed solution is a single unified platform\",\"All systems would communicate and integrate with each other\",\"AI implementation would enable natural language navigation\"]","[]","[]","[]","2026-05-27 14:35:20.951"),
    ("cmpo7n771000bc0vdx6bop3mt","cmpo65j260001eb8ftxd313th","Discussion of a lead generation and CRM platform with integrated features including prospect research, email outreach, contact management, and task scheduling.","[\"Recommend separate email addresses for lead generation versus internal communications\",\"Platform includes Lead Scraper, CRM, Omnichannel Outreach, Tasks calendar, and Knowledge Base\",\"Users can control access permissions through admin panels\",\"Outreach sequences are customizable with scheduling rules and rate limiting\",\"Backend infrastructure uses Firebase or Supabase for security and data hosting\"]","[\"Add documentation about email sending limits\",\"Develop customizable dashboard feature\",\"Complete LinkedIn outreach functionality\",\"Test and implement Outlook calendar sync feature\",\"Refine competitor analysis feature\",\"Expand and simplify the outreach step builder interface\"]","[\"Offer flexible deployment options\",\"Position all features as modular products within one OS\",\"Use Firebase/Supabase backend infrastructure\",\"Implement folder-based access controls\"]","[{\"time\":0,\"title\":\"Email address configuration\"},{\"time\":281,\"title\":\"Dashboard and CRM features\"},{\"time\":405,\"title\":\"Contact visibility permissions\"},{\"time\":829,\"title\":\"Email templates and sequences\"},{\"time\":1213,\"title\":\"Scheduling and calendar integration\"},{\"time\":1655,\"title\":\"Product bundling strategy\"},{\"time\":1869,\"title\":\"Server hosting and deployment\"}]","2026-05-27 15:19:56.461"),
]

def dq(v):
    """Dollar-quote a string, switching to $q$ if needed."""
    if "$$" not in v:
        return f"$${v}$$"
    return f"$q${v}$q$"

lines.append("-- Summaries")
for s in summaries:
    lines.append(
        f'INSERT INTO "Summary" (id, "recordingId", overview, "keyPoints", "actionItems", decisions, topics, "createdAt") '
        f'VALUES ({ql(s[0])}, {ql(s[1])}, {dq(s[2])}, {dq(s[3])}, {dq(s[4])}, {dq(s[5])}, {dq(s[6])}, {ts(s[7])}) ON CONFLICT (id) DO NOTHING;'
    )
lines.append("")

# ── Transcripts (from pre-generated file) ───────────────────────────────────
transcript_file = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'Users', 'ryan.murphy', 'transcript_insert.sql')
transcript_file = r"C:\Users\ryan.murphy\transcript_insert.sql"
lines.append("-- Transcripts")
try:
    with open(transcript_file, encoding="utf-8") as f:
        lines.append(f.read())
except FileNotFoundError:
    lines.append("-- WARNING: transcript_insert.sql not found at " + transcript_file)

output_path = r"C:\Users\ryan.murphy\FTC - Transcribe\migration-to-contacts.sql"
with open(output_path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

print(f"Written to: {output_path}")
import os
size = os.path.getsize(output_path)
print(f"File size: {size:,} bytes ({size//1024} KB)")
