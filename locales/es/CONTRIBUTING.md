<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • <b>Español</b> • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Contribuir a Zoo Code

Zoo Code es un proyecto comunitario. Valoramos cada contribución. Trabajamos con el enfoque de [primero la incidencia](#issue-first-approach). Esto significa que cada [Pull Request (PR)](#submitting-a-pull-request) debe enlazar a una incidencia de GitHub. Lee esta guía con atención.

<a id="table-of-contents"></a>

## Índice

- [Antes de contribuir](#before-you-contribute)
- [Encontrar y planificar tu contribución](#finding--planning-your-contribution)
- [Proceso de desarrollo y envío](#development--submission-process)
    - [Expectativas de los Pull Requests](#pull-request-expectations)
    - [Contribuciones con ayuda de IA](#ai-assisted-contributions)
    - [Estilo de escritura](#writing-style)
- [Aspectos legales](#legal)

<a id="before-you-contribute"></a>

## Antes de contribuir

<a id="1-code-of-conduct"></a>

### 1. Código de conducta

Todos los colaboradores deben seguir nuestro [código de conducta](./CODE_OF_CONDUCT.md).

<a id="2-project-roadmap"></a>

### 2. Hoja de ruta del proyecto

Nuestra hoja de ruta muestra la dirección del proyecto. Alinea tus contribuciones con estos objetivos:

<a id="reliability-first"></a>

### La fiabilidad primero

- Haz que la edición con diff y la ejecución de comandos sean fiables siempre.
- Elimina los problemas que impiden usar Zoo Code cada día.
- Haz que Zoo Code funcione en todos los idiomas y plataformas.
- Añade soporte para más proveedores y modelos de IA.

<a id="enhanced-user-experience"></a>

### Mejor experiencia de usuario

- Haz que la UI y la UX sean claras y fáciles de usar.
- Mejora el flujo de trabajo. Los desarrolladores esperan un nivel alto de las herramientas que usan cada día.

<a id="leading-on-agent-performance"></a>

### Liderar el rendimiento de los agentes

- Crea pruebas de evaluación (evals) que midan la productividad en situaciones reales.
- Haz que las evals sean fáciles de ejecutar y de leer.
- Publica mejoras que aumenten claramente las puntuaciones de las evals.

En tus PRs, indica a cuáles de estas áreas ayuda el cambio.

<a id="3-join-the-zoo-code-community"></a>

### 3. Únete a la comunidad de Zoo Code

- **Discord:** Únete a nuestro [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Únete a nuestro [Reddit](https://www.reddit.com/r/ZooCode/).

<a id="finding--planning-your-contribution"></a>

## Encontrar y planificar tu contribución

<a id="types-of-contributions"></a>

### Tipos de contribuciones

- **Correcciones de errores:** Corrige problemas del código.
- **Nuevas funciones:** Añade funciones.
- **Documentación:** Mejora las guías y hazlas más claras.

<a id="issue-first-approach"></a>

### Primero la incidencia

Cada contribución empieza con una incidencia de GitHub. Usa nuestras plantillas breves.

- **Comprueba las incidencias existentes**: Busca en [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Crea una incidencia** con:
    - **Mejoras:** La plantilla "Enhancement Request" (lenguaje sencillo centrado en el beneficio para el usuario).
    - **Errores:** La plantilla "Bug Report" (reproducción mínima, resultado esperado y real, versión).
- **Escribe la incidencia** con el [estilo de escritura](#writing-style) que encontrarás más abajo.
- **¿Quieres trabajar en ella?** Comenta "Claiming" en la incidencia. Después contacta con el equipo principal en [Discord](https://discord.gg/VxfP4Vx3gX) para que te la asigne. El equipo principal confirma la asignación en el hilo.
- **Los PRs deben enlazar a la incidencia.** Podemos cerrar los PRs que no tengan ese enlace.

<a id="deciding-what-to-work-on"></a>

### Decidir en qué trabajar

- Consulta la [página de GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Para la documentación, ve a [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Informar de errores

- Primero comprueba si ya hay informes.
- Crea un informe de error con la [plantilla "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) e incluye:
    - Pasos claros y numerados para reproducir el error
    - Resultado esperado y resultado real
    - Versión de Zoo Code (obligatoria)
    - Proveedor de API y modelo, si son relevantes
- **Problemas de seguridad**: Informa de ellos en privado mediante los [avisos de seguridad](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Proceso de desarrollo y envío

<a id="development-setup"></a>

### Preparar el entorno de desarrollo

1. **Haz un fork y clona el repositorio:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Instala las dependencias:**

```
pnpm install
```

3. **Depuración:** Ábrelo con VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Pautas para escribir código

- Un PR centrado en cada función o corrección.
- Sigue las buenas prácticas de ESLint y TypeScript.
- Escribe commits claros y descriptivos que hagan referencia a incidencias (por ejemplo, `Fixes #123`). Sigue el [estilo de escritura](#writing-style).
- Prueba el cambio a fondo (`npm test`).
- Haz rebase sobre la versión más reciente de la rama `main` antes de enviarlo.

<a id="submitting-a-pull-request"></a>

### Enviar un Pull Request

- Empieza con un **PR en borrador** si quieres recibir comentarios pronto.
- Describe tus cambios con la plantilla Pull Request Template. Sigue el [estilo de escritura](#writing-style).
- Enlaza la incidencia en la descripción o el título del PR (por ejemplo, "Fixes #123").
- Añade capturas de pantalla o vídeos si cambias la UI.
- Indica si el cambio necesita actualizaciones de la documentación.

<a id="pull-request-policy"></a>

### Política de los Pull Requests

- El PR debe hacer referencia a una incidencia de GitHub asignada. Para conseguir la asignación, comenta "Claiming" en la incidencia. Después contacta con el equipo principal en [Discord](https://discord.gg/VxfP4Vx3gX). El equipo principal confirma la asignación en el hilo.
- Podemos cerrar los PRs que no tengan ese enlace.
- Un PR debe superar las pruebas de CI, seguir la hoja de ruta y tener documentación clara.

<a id="review-process"></a>

### Proceso de revisión

Un PR listo para la revisión debe cumplir estas condiciones:

- Supera las comprobaciones de CI obligatorias.
- Resuelve los comentarios de revisión que requieren acciones.
- Recibe una nueva aprobación de un mantenedor o CODEOWNER. Esto ocurre después de que termine la revisión automática del commit más reciente.

La revisión automática puede añadir un comentario de orientación y etiquetas de estado gestionadas. Sigue el siguiente paso del comentario. No edites las etiquetas por tu cuenta. Los commits nuevos reinician el estado de revisión del código modificado.

La etiqueta `community-approved` indica una nueva aprobación de la comunidad sobre el commit más reciente. El PR espera entonces la revisión de un mantenedor. La etiqueta orienta a los mantenedores sobre la prioridad. No sustituye la revisión de un mantenedor ni una comprobación obligatoria. El flujo de revisión gestiona la etiqueta.

La revisión automática ayuda a los mantenedores. No sustituye la aprobación humana. Los colaboradores externos no pueden dar instrucciones a CodeRabbit mediante comentarios. Una revisión que cumple los requisitos se reinicia sola cuando supera la CI obligatoria. Los mantenedores gestionan los reinicios excepcionales. Los avisos son orientativos, salvo que la política del repositorio indique lo contrario. Las comprobaciones obligatorias de GitHub, las reglas de CODEOWNER y las protecciones de revisión determinan si se puede fusionar un PR.

- **Clasificación diaria:** Los mantenedores hacen comprobaciones rápidas.
- **Revisión semanal a fondo:** Los mantenedores hacen una evaluación completa.
- **Haz ajustes rápidamente** cuando recibas comentarios.

<a id="pull-request-expectations"></a>

### Expectativas de los Pull Requests

Un PR debe ser fácil de revisar, estar probado y ser fácil de mantener. Antes de abrir un PR, comprueba estos puntos:

- El cambio trata una incidencia, un error o una mejora concreta.
- Puedes explicar qué hace el cambio y por qué es correcto.
- Has probado el cambio en tu ordenador siempre que ha sido posible.
- Responderás a los comentarios de revisión y harás los ajustes razonables que hagan falta.
- Los mantenedores no necesitan reescribir, rediseñar ni asumir el cambio antes de poder fusionarlo.

Los mantenedores pueden cerrar un PR por estos motivos:

- Está incompleto.
- Es demasiado amplio.
- Está inactivo.
- No sigue la dirección del proyecto.
- Genera demasiado trabajo de revisión o mantenimiento.

Cerrar un PR no es un juicio sobre el colaborador. Significa que los mantenedores no pueden aceptar el cambio en su forma actual.

Un bot también cierra PRs automáticamente:

- **60 días de inactividad:** El bot marca un PR como inactivo tras 60 días sin actividad. Si pasan 7 días más sin actividad, lo cierra. Un comentario, commit o revisión nuevos reinician el contador.
- **14 días de inactividad del autor:** Cuando un revisor pide cambios, el bot añade la etiqueta `awaiting-author`. La actividad del autor reinicia el contador de inactividad. Cuando los cambios estén listos, pide una nueva revisión al revisor.

Para evitar el cierre automático de un PR, añade la etiqueta `do-not-close`, `pinned` o `work-in-progress`.

<a id="ai-assisted-contributions"></a>

### Contribuciones con ayuda de IA

Puedes usar herramientas de IA. Sigues siendo plenamente responsable de lo que envías.

Si usas herramientas de IA para crear un PR, debes:

- Revisar y entender cada cambio importante.
- Explicar la implementación y sus ventajas e inconvenientes con tus propias palabras.
- Probar el cambio tú mismo. Si no puedes probarlo en tu entorno, explica por qué en la descripción del PR. Describe también cómo pueden comprobar el cambio los revisores.
- Comprobar que el código generado es correcto, necesario y compatible con la licencia del proyecto.
- Valorar si debes mencionar la ayuda de IA en la descripción del PR. Hazlo cuando esa ayuda haya cambiado mucho el código, las pruebas o el diseño. Esto ayuda a los revisores a dar comentarios más útiles.

No envíes cambios generados por IA que no entiendas. No envíes cambios que no puedas mantener durante la revisión. Los mantenedores pueden cerrar un PR que parezca tener mucha ayuda de IA. Pueden hacerlo si falta verificación humana, un motivo claro o seguimiento durante la revisión.

<a id="writing-style"></a>

### Estilo de escritura

Estas reglas se aplican a los textos en inglés. Escribe los títulos y textos de incidencias, los títulos y descripciones de PRs y los mensajes de commit en [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/). Las plantillas de incidencias y PRs incluyen el mismo recordatorio.

- Usa frases cortas. Usa 20 palabras o menos para una instrucción.
- Usa palabras sencillas. Escribe "use", no "utilize". Escribe "start", no "commence".
- Usa la voz activa. Escribe "the parser reads the file", no "the file is read by the parser".
- Escribe una idea por frase.
- No uses contracciones, puntos y coma ni rayas largas.
- Haz que el título sea corto y concreto.
- No cambies los registros, mensajes de error, identificadores, comandos ni pruebas de reproducción exactos. Pégalos tal como están.

Estas reglas son pautas de escritura. Los revisores no comprueban el cumplimiento formal de ASD-STE100. El código, los identificadores y la sintaxis de los comandos no forman parte de esta regla.

<a id="legal"></a>

## Aspectos legales

Al contribuir, aceptas que tus contribuciones usen la licencia Apache 2.0. Esta es la licencia de Zoo Code.
