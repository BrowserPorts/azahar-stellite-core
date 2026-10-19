// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <QMessageBox>
#include <QPointer>
#include <QProgressDialog>
#include <QTimer>
#include <emscripten.h>
#include <emscripten/val.h>
#include "web/qt/file-dialog.h"

namespace {

EM_JS(bool, BeginGameImport, (const char* accept, bool multiple), {
    return Module["azaharQtRuntime"].beginGameImport(UTF8ToString(accept), !!multiple);
});

EM_JS(emscripten::EM_VAL, GameImportStatus, (), {
    return Emval.toHandle(Module["azaharQtRuntime"].gameImportStatus());
});

EM_JS(void, CancelGameImport, (), {
    Module["azaharQtRuntime"].cancelGameImport();
});

EM_JS(void, FinishGameImport, (), {
    Module["azaharQtRuntime"].finishGameImport();
});

} // namespace

namespace Web::Qt {

void OpenFiles(QWidget* parent, const QStringList& extensions, bool multiple,
               std::function<void(const QStringList&)> completed) {
    QStringList accept;
    for (const auto& extension : extensions) {
        accept.append(QStringLiteral(".") + extension);
    }
    if (!BeginGameImport(accept.join(QStringLiteral(",")).toUtf8().constData(), multiple)) {
        completed({});
        return;
    }
    auto* progress = new QProgressDialog(
        multiple ? QObject::tr("Importing files…") : QObject::tr("Importing game…"),
        QObject::tr("Cancel"), 0, 1000, parent);
    const auto title = multiple ? QObject::tr("Load Files") : QObject::tr("Load File");
    progress->setWindowTitle(title);
    progress->setWindowModality(::Qt::WindowModal);
    progress->setMinimumDuration(250);
    progress->setAutoClose(false);
    progress->setAutoReset(false);
    // Start the progress timer only after the browser picker has supplied a file.
    progress->reset();
    QObject::connect(progress, &QProgressDialog::canceled, [] { CancelGameImport(); });
    const auto destroyed =
        QObject::connect(progress, &QObject::destroyed, [] { CancelGameImport(); });

    auto* timer = new QTimer(progress);
    const QPointer<QWidget> owner(parent);
    QObject::connect(timer, &QTimer::timeout, progress, [=] {
        const auto status = emscripten::val::take_ownership(GameImportStatus());
        if (!status["done"].as<bool>()) {
            const auto fraction = status["progress"].as<double>();
            if (fraction >= 0 && !progress->wasCanceled()) {
                progress->setValue(static_cast<int>(std::clamp(fraction, 0.0, 1.0) * 1000));
            }
            return;
        }
        timer->stop();
        const auto paths = status["paths"];
        QStringList filepaths;
        const auto count = paths["length"].as<unsigned>();
        for (unsigned i = 0; i < count; ++i) {
            filepaths.append(QString::fromStdString(paths[i].as<std::string>()));
        }
        const auto error = QString::fromStdString(status["error"].as<std::string>());
        const bool canceled = progress->wasCanceled();
        FinishGameImport();
        QObject::disconnect(destroyed);
        progress->deleteLater();
        if (!owner) return;
        QTimer::singleShot(0, owner, [=] {
            if (!error.isEmpty()) {
                QMessageBox::critical(owner, title, error.toHtmlEscaped());
            }
            completed(canceled ? QStringList{} : filepaths);
        });
    });
    timer->start(50);
}

} // namespace Web::Qt
