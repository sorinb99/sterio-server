Sterio Server pentru Mac
============================

Cu aplicația asta, Mac-ul tău devine serverul de muzică pentru Sterio
pe iPhone. Nu trebuie să mai instalezi nimic altceva.


1. INSTALARE (o singură dată)
-----------------------------
1. Deschide fișierul "Sterio-Server.dmg" (dublu-clic).
2. Trage iconița "Sterio Server" peste folderul "Applications".
3. Deschide "Sterio Server" din Applications (sau din Launchpad).

Dacă Mac-ul spune că aplicația nu poate fi deschisă:
   - Deschide System Settings (Setări sistem) → Privacy & Security
     (Confidențialitate și securitate).
   - Mergi jos de tot. La "Sterio Server" apasă "Open Anyway"
     (Deschide oricum), apoi confirmă.
   Asta se întâmplă doar prima dată.

Dacă Mac-ul te întreabă dacă aplicația poate primi conexiuni, poate
căuta dispozitive în rețeaua locală sau poate accesa un folder,
apasă "Allow" (Permite).


2. PRIMA PORNIRE: alegi muzica
------------------------------
Când pornește aplicația, se deschide singură o pagină în browser.

1. La secțiunea "THIS MAC" apasă "Choose music folder…".
2. Se deschide o fereastră: alege folderul cu muzica ta și apasă "Choose".
3. Serverul repornește și începe să-ți citească muzica. La o colecție mare
   prima citire poate dura de la câteva minute la o oră. Între timp poți
   asculta ce a găsit deja.


3. CONECTEZI IPHONE-UL
----------------------
iPhone-ul trebuie să fie pe același Wi-Fi ca Mac-ul.

1. Pe iPhone deschide Sterio și alege "Sterio Server".
2. Alege Mac-ul tău din lista de servere găsite. Dacă nu apare, scrie
   adresa afișată pe pagina din browser, sub "Connect your iPhone"
   (de forma http://192.168.x.x:7766).
3. Apasă "Connect to Sterio". Telefonul arată un cod din 4 cifre și
   așteaptă.
4. Pe Mac, pagina din browser se deschide singură, cu "Connection
   requests" sus. Verifică să fie același cod și apasă "Accept".
   Telefonul se conectează imediat.

Asta faci o singură dată pe fiecare telefon.


4. ÎN FIECARE ZI
----------------
- Cât timp aplicația e deschisă (iconița ei e în Dock), muzica merge pe
  telefon. Închide-o cu Quit (Cmd+Q) când nu mai asculți: serverul se oprește.
- Sus, în bara de meniu, logo-ul Sterio arată că serverul merge. Un clic pe
  el arată starea, câte albume și piese ai, adresa pentru telefoane (clic ca
  s-o copiezi), plus: Open Dashboard, Choose Music Folder, Show Music in
  Finder, Open at Login (pornește singur când pornești Mac-ul), Show Server
  Log și Quit.
- Data viitoare când o deschizi, ține minte tot: folderul, telefoanele
  și muzica deja citită.
- Pagina din browser se deschide la fiecare pornire. Dacă ai închis-o, apasă
  pe iconița Sterio Server din Dock și se deschide din nou.
- Cât timp aplicația e deschisă, Mac-ul nu intră singur în sleep, ca muzica
  să nu se oprească. Ecranul se poate stinge liniștit.
- Muzică nouă în folder? Serverul o găsește singur în cel mult 15 minute,
  sau apasă "Scan library" în pagina Library.


5. STREAMER (Eversolo, Bluesound, …)
------------------------------------
Dacă streamerul e în aceeași rețea:
- Pe iPhone, în Now Playing, apasă butonul de dispozitive și alege
  streamerul. Muzica pornește pe streamer, iar telefonul devine
  telecomandă. Poți bloca telefonul liniștit.
- Dacă nu apare în listă, apasă "Search again".


6. MUZICA DE LA ALT SERVER STERIO (opțional)
-----------------------------------------------
În pagina din browser:
1. Deschide "Linked servers".
2. Scrie adresa celuilalt server (cheia nu mai e necesară).
3. Apasă "Connect". Celălalt server primește o cerere: proprietarul lui o
   acceptă pe pagina lui sau din aplicația Sterio.
Muzica lui apare apoi pe telefonul tău, lângă a ta. Pentru fișiere
hi-res sau DSD e nevoie de internet bun la amândoi.


7. DACĂ CEVA NU MERGE
---------------------
- Telefonul nu se poate conecta, deși pe Mac merge:
  1. Uită-te pe pagina din browser. Dacă apare un avertisment despre
     Firewall, apasă "Allow iPhones to connect" și scrie parola Mac-ului.
  2. Pe iPhone deschide Safari și intră la adresa de pe pagină, la care
     adaugi /healthz (ex: http://192.168.1.20:7766/healthz).
     - Dacă pagina nu se deschide: telefonul nu ajunge la Mac. Verifică dacă
       ești pe același Wi-Fi (nu pe rețeaua "Guest") și Firewall-ul de mai sus.
     - Dacă apare "status":"ok", dar aplicația tot nu se conectează: pe iPhone
       mergi la Settings → Privacy & Security → Local Network și pornește
       Sterio.
  3. Verifică dacă aplicația Sterio Server e deschisă pe Mac.
- În aplicația de pe iPhone: Settings → "Export diagnostics" și trimite
  fișierul celui care ți-a dat aplicația.
- Jurnalul serverului: meniul Sterio Server → "Show Server Log".

Unde stau datele, dacă vreodată vrei să le ștergi:
   ~/Library/Application Support/Sterio Server
Fișierele tale de muzică nu sunt modificate și nici mutate.
