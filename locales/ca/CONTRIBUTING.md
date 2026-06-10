<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • <b>Català</b> • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Contribuir a Zoo Code

Zoo Code és un projecte impulsat per la comunitat i valorem profundament cada contribució. Per agilitzar la col·laboració, operem sobre una base de [primer la incidència](#enfocament-de-primera-incidència), la qual cosa significa que totes les [sol·licituds d'extracció (PR)](#enviament-duna-sollicitud-dextracció) primer han d'estar enllaçades a una incidència de GitHub. Si us plau, reviseu aquesta guia amb atenció.

## Taula de continguts

- [Abans de contribuir](#abans-de-contribuir)
- [Trobar i planificar la vostra contribució](#trobar-i-planificar-la-vostra-contribució)
- [Procés de desenvolupament i submissió](#procés-de-desenvolupament-i-submissió)
- [Expectatives de les sol·licituds d'extracció](#expectatives-de-les-sollicituds-dextracció)
- [Contribucions amb assistència d'IA](#contribucions-amb-assistència-dia)
- [Legal](#legal)

## Abans de contribuir

### 1. Codi de Conducta

Tots els col·laboradors han de complir el nostre [Codi de Conducta](./CODE_OF_CONDUCT.md).

### 2. Full de ruta del projecte

El nostre full de ruta guia la direcció del projecte. Alineeu les vostres contribucions amb aquests objectius clau:

### La fiabilitat primer

- Assegureu-vos que l'edició de diferències i l'execució d'ordres siguin fiables de manera consistent.
- Reduïu els punts de fricció que desincentiven l'ús habitual.
- Garantiu un funcionament fluid en tots els llocs i plataformes.
- Amplieu el suport robust per a una àmplia varietat de proveïdors i models d'IA.

### Experiència d'usuari millorada

- Agilitzeu la interfície d'usuari/experiència d'usuari per a més claredat i intuïtivitat.
- Milloreu contínuament el flux de treball per satisfer les altes expectatives que els desenvolupadors tenen de les eines d'ús diari.

### Liderant en rendiment d'agents

- Establir punts de referència d'avaluació complets (evals) per mesurar la productivitat del món real.
- Feu que sigui fàcil per a tothom executar i interpretar aquestes avaluacions.
- Envieu millores que demostrin augments clars en les puntuacions d'avaluació.

Mencioneu l'alineació amb aquestes àrees a les vostres sol·licituds d'extracció.

### 3. Uneix-te a la comunitat de Zoo Code

- **Discord:** Uneix-te al nostre [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Uneix-te al nostre [Reddit](https://www.reddit.com/r/ZooCode/).

## Trobar i planificar la vostra contribució

### Tipus de contribucions

- **Correccions d'errors:** abordar problemes de codi.
- **Noves característiques:** afegir funcionalitats.
- **Documentació:** millorar les guies i la claredat.

### Enfocament de primera incidència

Totes les contribucions comencen amb una incidència de GitHub utilitzant les nostres plantilles bàsiques.

- **Comproveu les incidències existents**: cerqueu a [Incidències de GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Creeu una incidència** utilitzant:
    - **Millores:** plantilla "Sol·licitud de millora" (llenguatge senzill centrat en el benefici per a l'usuari).
    - **Errors:** plantilla "Informe d'error" (reproducció mínima + esperat vs real + versió).
- **Voleu treballar-hi?** Comenteu "Reclamant" a la incidència i envieu un missatge directe a l'equip principal a [Discord](https://discord.gg/VxfP4Vx3gX) per ser assignat. L'assignació es confirmarà al fil.
- **Les sol·licituds d'extracció han d'enllaçar a la incidència.** Les sol·licituds d'extracció no enllaçades es poden tancar.

### Decidir en què treballar

- Consulta la [pàgina de GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues) per veure les issues.
- Per a documents, visiteu [Documents de Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

### Informar d'errors

- Comproveu primer si hi ha informes existents.
- Creeu un error nou utilitzant la [plantilla "Informe d'error"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) amb:
    - Passos de reproducció clars i numerats
    - Resultat esperat vs real
    - Versió de Zoo Code (obligatori); proveïdor/model d'API si és rellevant
- **Problemes de seguretat**: informeu de manera privada a través d'[avisos de seguretat](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

## Procés de desenvolupament i submissió

### Configuració del desenvolupament

1. **Bifurcació i clonació:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Instal·leu les dependències:**

```
pnpm install
```

3. **Depuració:** Obriu amb VS Code (`F5`).

### Directrius per escriure codi

- Una sol·licitud d'extracció centrada per característica o correcció.
- Seguiu les millors pràctiques d'ESLint i TypeScript.
- Escriviu confirmacions clares i descriptives que facin referència a incidències (p. ex., `Soluciona #123`).
- Proporcioneu proves exhaustives (`npm test`).
- Rebaseu a la branca `main` més recent abans de la submissió.

### Enviament d'una sol·licitud d'extracció

- Comenceu com a **PR d'esborrany** si busqueu comentaris primerencs.
- Descriviu clarament els vostres canvis seguint la plantilla de sol·licitud d'extracció.
- Enllaceu la incidència a la descripció/títol de la PR (p. ex., "Soluciona #123").
- Proporcioneu captures de pantalla/vídeos per a canvis a la interfície d'usuari.
- Indiqueu si calen actualitzacions de la documentació.

### Política de sol·licitud d'extracció

- Ha de fer referència a una incidència de GitHub assignada. Per ser assignat: comenteu "Reclamant" a la incidència i envieu un missatge directe a l'equip principal a [Discord](https://discord.gg/VxfP4Vx3gX). L'assignació es confirmarà al fil.
- Les sol·licituds d'extracció no enllaçades es poden tancar.
- Les sol·licituds d'extracció han de passar les proves de CI, alinear-se amb el full de ruta i tenir una documentació clara.

### Procés de revisió

- **Triatge diari:** revisions ràpides per part dels mantenidors.
- **Revisió setmanal en profunditat:** avaluació completa.
- **Itereu ràpidament** en funció dels comentaris.

### Expectatives de les sol·licituds d'extracció

Les sol·licituds d'extracció han de ser revisables, provades i mantenibles. Abans d'obrir una PR, assegureu-vos que:

- El canvi s'adapta a un problema, error o millora específics.
- Podeu explicar què fa el canvi i per què és correcte.
- Heu provat el canvi localment on sigui pràctic.
- Esteu disposats a respondre als comentaris de la revisió i fer canvis raonables de seguiment.
- La PR no requereix que els mantenidors reescriguin, redissenyin o assumeixin la propietat substancial de la implementació abans de poder fusionar-la.

Els mantenidors poden tancar les PR que estiguin incompletes, siguin massa àmplies, inactives, no estiguin alineades amb la direcció del projecte o que creïn una càrrega desproporcionada de revisió o manteniment. Tancar una PR no és un judici sobre el col·laborador; és una decisió dels mantenidors que el canvi no pot ser acceptat en la seva forma actual.

### Contribucions amb assistència d'IA

L'ús d'eines d'IA és permès, però els col·laboradors continuen sent completament responsables de les seves aportacions.

Si utiliseu eines d'IA per ajudar a crear una PR, heu de:

- Revisar i comprendre cada canvi significatiu.
- Ser capaços d'explicar la implementació i els compromisos amb les vostres pròpies paraules.
- Provar el canvi vosaltres mateixos. Si les proves no són pràctiques en el vostre entorn, expliqueu per què a la descripció de la PR i descriviu com els revisors poden verificar el canvi.
- Verificar que el codi generat és correcte, necessari i compatible amb la llicència del projecte.
- Considereu revelar l'assistència d'IA a la descripció de la PR quan hagi influït materialment en el codi, les proves o el disseny — això ajuda els revisors a donar millors comentaris.

Si us plau, no envieu canvis generats per IA que no enteneu o que no podeu mantenir durant la revisió. Els mantenidors poden tancar les PR que semblin substancialment assistides per IA però que manquin de verificació humana, raonament clar o seguiment de la revisió.

## Legal

En contribuir, accepteu que les vostres contribucions es llicenciaran sota la llicència Apache 2.0, d'acord amb la llicència de Zoo Code.
